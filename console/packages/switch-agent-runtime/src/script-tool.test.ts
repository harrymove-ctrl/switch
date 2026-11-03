import { beforeAll, describe, expect, it, type Mock, vi } from 'vitest';
import type { OperationOutcome, SwitchOperation } from './hosted';
import {
  runSwitchScript,
  runSwitchScriptTool,
  SCRIPT_LIMITS,
  scriptDeclarations,
  type ScriptOperationRequest,
} from './script-tool';

const { maxCalls, maxOutputChars } = SCRIPT_LIMITS;

/** Shapes copied from what `GET /ops` serves for these operations. */
const READ_CONTEXT: SwitchOperation = {
  name: 'read_context',
  description: 'Read the room.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      limit: { default: 50, title: 'Limit', type: 'integer' },
      since: { anyOf: [{ type: 'string' }, { type: 'null' }], default: null, title: 'Since' },
      room_id: { anyOf: [{ type: 'string' }, { type: 'null' }], default: null, title: 'Room Id' },
    },
  },
};
const SEND_TARGETED_MESSAGE: SwitchOperation = {
  name: 'send_targeted_message',
  description: 'Address someone.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['body'],
    properties: {
      body: { title: 'Body', type: 'string' },
      target_names: {
        anyOf: [{ items: { type: 'string' }, type: 'array' }, { type: 'null' }],
        default: null,
      },
    },
  },
};
const LIST_ROOMS: SwitchOperation = {
  name: 'list_rooms',
  description: 'Your rooms.',
  input_schema: { type: 'object', additionalProperties: false, properties: {} },
};
const POST_MESSAGE: SwitchOperation = {
  name: 'post_message',
  description: 'Post.',
  input_schema: { type: 'object', required: ['body'], properties: { body: { type: 'string' } } },
};
const CREATE_ROOM: SwitchOperation = {
  name: 'create_room',
  description: 'Provision a room.',
  input_schema: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } },
};
const CONNECT_TO_ROOM: SwitchOperation = {
  name: 'connect_to_room',
  description: 'Enter a room.',
  input_schema: {
    type: 'object',
    required: ['room_id'],
    properties: { room_id: { type: 'string' } },
  },
};
const OPERATIONS = [
  LIST_ROOMS,
  READ_CONTEXT,
  SEND_TARGETED_MESSAGE,
  POST_MESSAGE,
  CREATE_ROOM,
  CONNECT_TO_ROOM,
];

function answering(results: Record<string, unknown>): Mock<ScriptOperationRequest> {
  return vi.fn<ScriptOperationRequest>(async (name): Promise<OperationOutcome> =>
    name in results ? { ok: true, result: results[name] } : { ok: false, error: `409: no ${name}` }
  );
}

function run(code: string, request: ScriptOperationRequest, limits = SCRIPT_LIMITS) {
  return runSwitchScript(code, OPERATIONS, limits, request);
}

function text(result: { content: { text: string }[] }): string {
  return result.content.map((part) => part.text).join('\n');
}

describe('the script declarations', () => {
  it('type each operation from its input schema', () => {
    expect(scriptDeclarations([LIST_ROOMS, READ_CONTEXT, SEND_TARGETED_MESSAGE])).toBe(
      [
        'declare const ops: {',
        '  list_rooms(args?: {}): Promise<unknown>;',
        '  read_context(args?: { limit?: number; since?: string | null; room_id?: string | null }): Promise<unknown>;',
        '  send_targeted_message(args: { body: string; target_names?: string[] | null }): Promise<unknown>;',
        '};',
        'declare function text(...values: unknown[]): void;',
      ].join('\n')
    );
  });

  it('declare only the operations a script may call', () => {
    const { description } = runSwitchScriptTool(OPERATIONS);
    expect(description).toContain('  post_message(args: { body: string }): Promise<unknown>;');
    expect(description).not.toContain('create_room(');
    expect(description).not.toContain('connect_to_room(');
  });
});

describe('a script', () => {
  // The first script in a process compiles QuickJS; keep that out of the timed tests.
  beforeAll(() => run('', answering({})), 30_000);

  it('chains operations and returns only what it prints', async () => {
    const request = answering({
      list_rooms: [{ room_id: 'a' }, { room_id: 'b' }],
      read_context: { threads: [{ root: { body: 'question?' } }, { root: { body: 'answer' } }] },
    });
    const result = await run(
      `
      const rooms = await ops.list_rooms();
      const reads = await Promise.all(rooms.map((r) => ops.read_context({ room_id: r.room_id })));
      const open = reads.flatMap((r) => r.threads).filter((t) => t.root.body.endsWith('?'));
      text(open.length, 'open questions in', rooms.length, 'rooms');
      `,
      request
    );
    expect(result).toEqual({
      content: [{ type: 'text', text: '2 open questions in 2 rooms' }],
      structuredContent: { posts_landed: 0, post_failures: [] },
    });
    expect(request.mock.calls).toEqual([
      ['list_rooms', {}],
      ['read_context', { room_id: 'a' }],
      ['read_context', { room_id: 'b' }],
    ]);
  });

  it('prints what it returns, and objects as JSON', async () => {
    const result = await run("console.log('rooms', 2); return { done: true };", answering({}));
    expect(text(result)).toBe('rooms 2\n{\n  "done": true\n}');
  });

  it("throws Switch's reason when an operation fails, keeping what it printed first", async () => {
    const result = await run("text('before'); await ops.read_context({});", answering({}));
    expect(result.isError).toBe(true);
    expect(text(result)).toBe(
      'before\nScript failed: Error: 409: no read_context\nCalls that completed: none.'
    );
  });

  it('can catch a failed operation and carry on', async () => {
    const result = await run(
      "try { await ops.read_context({}); } catch (e) { text('caught ' + e.message); }",
      answering({})
    );
    expect(result).toEqual({
      content: [{ type: 'text', text: 'caught 409: no read_context' }],
      structuredContent: { posts_landed: 0, post_failures: [] },
    });
  });

  it('cannot call an operation outside the script allowlist', async () => {
    const request = answering({ create_room: 'made', connect_to_room: 'moved' });
    const result = await run(
      "text(typeof ops.create_room, typeof ops.connect_to_room); await ops.create_room({ name: 'x' });",
      request
    );
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('undefined undefined');
    expect(request).not.toHaveBeenCalled();
  });

  it('refuses arguments that are not one plain object', async () => {
    const request = answering({ post_message: 'posted' });
    const result = await run("await ops.post_message(new Map([['body', 'hi']]));", request);
    expect(text(result)).toContain('post_message takes one plain object of arguments');
    expect(request).not.toHaveBeenCalled();
  });

  it(`stops after ${maxCalls} operation calls and says which completed`, async () => {
    const request = answering({ list_rooms: [] });
    const result = await run(
      `for (let i = 0; i < ${maxCalls + 10}; i++) await ops.list_rooms();`,
      request
    );
    expect(text(result)).toBe(
      `Script failed: it made more than ${maxCalls} operation calls\n` +
        `Calls that completed: list_rooms (${maxCalls}).`
    );
    expect(request).toHaveBeenCalledTimes(maxCalls);
  });

  it('says which posts landed when the cap stops a burst, so a retry does not repeat them', async () => {
    const request = answering({ post_message: 'posted' });
    const result = await run(
      `await Promise.all(Array.from({ length: ${maxCalls + 10} }, (_, i) => ops.post_message({ body: 'n' + i })));`,
      request
    );
    expect(text(result)).toBe(
      `Script failed: it made more than ${maxCalls} operation calls\n` +
        `Calls that completed: post_message (${maxCalls}).`
    );
    expect(request).toHaveBeenCalledTimes(maxCalls);
  });

  it('stops when its output passes the limit, keeping exactly the limit', async () => {
    const result = await run(
      `text('x'.repeat(${maxOutputChars})); text('y'.repeat(50000)); text('never');`,
      answering({})
    );
    expect(result.isError).toBe(true);
    const [printed, ...rest] = text(result).split('\n');
    expect(printed).toBe('x'.repeat(maxOutputChars));
    expect(rest[0]).toBe(`Script failed: it printed more than ${maxOutputChars} characters`);
    expect(text(result)).not.toContain('never');
  });

  it('reports a syntax error as a failure', async () => {
    const result = await run('text(', answering({}));
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('SyntaxError');
  });

  it('reaches nothing of the host: no require, process, fetch, timers or host functions', async () => {
    const result = await run(
      [
        'text([typeof require, typeof process, typeof fetch, typeof setTimeout].join(" "));',
        'text(text.constructor("return typeof process")());',
        'text(typeof globalThis.__switch_call, typeof globalThis.__switch_print);',
      ].join('\n'),
      answering({})
    );
    expect(text(result)).toBe(
      'undefined undefined undefined undefined\nundefined\nundefined undefined'
    );
  });

  it('is stopped at its deadline even when it never yields', async () => {
    const result = await run(
      'await ops.list_rooms(); while (true) {}',
      answering({ list_rooms: [] }),
      {
        ...SCRIPT_LIMITS,
        deadlineMs: 200,
      }
    );
    expect(text(result)).toContain('Script failed: it ran longer than 0.2 seconds');
    expect(text(result)).toContain('Calls that completed: list_rooms (1).');
  });

  it('is stopped at its deadline while an operation call is still out', async () => {
    const request = vi.fn<ScriptOperationRequest>(() => new Promise(() => {}));
    const result = await run("await ops.post_message({ body: 'hi' });", request, {
      ...SCRIPT_LIMITS,
      deadlineMs: 100,
    });
    expect(text(result)).toBe(
      'Script failed: it ran longer than 0.1 seconds\nCalls that completed: none.\n' +
        'Still in flight when it stopped, outcome unknown: post_message (1).'
    );
  });

  it('is stopped when it runs out of memory', async () => {
    const result = await run(
      "const keep = []; while (true) keep.push('x'.repeat(1 << 20));",
      answering({}),
      { ...SCRIPT_LIMITS, memoryBytes: 8 * 1024 * 1024 }
    );
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('out of memory');
  }, 30_000);

  it('waits for calls still out when the body ends, and reports the posts', async () => {
    const result = await run(
      "ops.post_message({ body: 'a' }); ops.post_message({ body: 'b' }); text('done');",
      answering({ post_message: 'posted' })
    );
    expect(result).toEqual({
      content: [{ type: 'text', text: 'done' }],
      structuredContent: { posts_landed: 2, post_failures: [] },
    });
  });

  it('reports refused posts in its fields, even when the script caught them', async () => {
    const result = await run(
      "try { await ops.post_message({ body: 'a' }); } catch {} text('carried on');",
      answering({})
    );
    expect(result).toEqual({
      content: [{ type: 'text', text: 'carried on' }],
      structuredContent: { posts_landed: 0, post_failures: ['409: no post_message'] },
    });
  });

  it('frees a call still out when it fails, and the next script still runs', async () => {
    const request = vi.fn<ScriptOperationRequest>(() => new Promise(() => {}));
    const failed = await run("ops.post_message({ body: 'a' }); throw new Error('stop');", request, {
      ...SCRIPT_LIMITS,
      deadlineMs: 100,
    });
    expect(text(failed)).toContain(
      'Still in flight when it stopped, outcome unknown: post_message (1).'
    );
    const next = await run('text(await ops.list_rooms());', answering({ list_rooms: 'rooms' }));
    expect(text(next)).toBe('rooms');
  });

  it('stops a body that runs without waiting, long before its deadline', async () => {
    // Where the interrupt lands varies from run to run, so each body runs several times.
    for (const body of Array.from({ length: 6 }, () => [
      'while (true) {}',
      'for (;;) await 0;',
    ]).flat()) {
      const started = Date.now();
      const result = await run(body, answering({}));
      expect(text(result)).toContain(
        `Script failed: it ran for more than ${SCRIPT_LIMITS.maxRunMs} ms without waiting on an operation`
      );
      expect(Date.now() - started).toBeLessThan(SCRIPT_LIMITS.deadlineMs / 2);
    }
  }, 30_000);

  it('cannot close its own wrapper to reach the host functions', async () => {
    const request = answering({ post_message: 'posted' });
    const result = await run(
      "}, (globalThis.c = __switch_call, globalThis.s = __switch_settle, 0)); c('post_message', '{\"body\":\"hi\"}'); s(''); (async () => {",
      request
    );
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("ReferenceError: '__switch_call' is not defined");
    expect(request).not.toHaveBeenCalled();
  });

  it('counts the line breaks between printed lines toward the output limit', async () => {
    const result = await run(
      `for (let i = 0; i < ${maxOutputChars}; i++) text('x');`,
      answering({})
    );
    expect(result.isError).toBe(true);
    expect(text(result)).toContain(
      `Script failed: it printed more than ${maxOutputChars} characters`
    );
    expect(text(result).split('\nScript failed')[0].length).toBeLessThanOrEqual(maxOutputChars);
  });

  it('leaves nothing behind between runs', async () => {
    for (let i = 0; i < 20; i++) {
      const result = await run(
        'globalThis.seen = (globalThis.seen ?? 0) + 1; text(await ops.list_rooms(), seen);',
        answering({ list_rooms: 'rooms' })
      );
      expect(text(result)).toBe('rooms 1');
    }
  });
});
