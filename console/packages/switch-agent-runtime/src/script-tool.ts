/**
 * `run_switch_script`: several Switch operations in one tool call.
 *
 * The agent writes a short async JavaScript body that calls `ops.<name>(args)`
 * and prints what it wants back with `text()`. Only the printed lines reach the
 * model, so a task that reads several rooms and posts one summary costs one
 * round trip, and the histories it read never enter the context.
 *
 * The body runs in QuickJS compiled to WebAssembly, not in this process's own
 * JavaScript engine. This process holds the agent's Switch credential, which
 * sessions are deliberately not given, and hosts allow the Switch tools without
 * a prompt, so a script must not be able to reach anything here: only strings
 * cross between the two, through one function that makes an operation call and
 * one that prints. Every call is an ordinary operation call as the caller,
 * authorised by Switch exactly as the tool of the same name would be.
 */

import variant from '@jitl/quickjs-singlefile-mjs-release-sync';
import {
  newQuickJSWASMModuleFromVariant,
  type QuickJSContext,
  type QuickJSDeferredPromise,
  type QuickJSWASMModule,
} from 'quickjs-emscripten-core';
import type { OperationOutcome, SwitchOperation, ToolDefinition, ToolResult } from './hosted';

export const RUN_SWITCH_SCRIPT_TOOL_NAME = 'run_switch_script';

/**
 * The operations a script can call: those that only read, and posting into the
 * connected room. Anything else either changes something the Switch skill tells
 * an agent to confirm with a person first, or has work done around it in the
 * session host (`connect_to_room` moves the session), so it stays a tool of its
 * own. An operation the server adds later is not callable from a script until
 * it is named here.
 */
export const SCRIPT_OPERATIONS: ReadonlySet<string> = new Set([
  'get_advanced_config',
  'get_agent_detail',
  'get_my_context',
  'get_role_detail',
  'get_room_detail',
  'get_room_group_detail',
  'get_template',
  'get_template_guide',
  'get_template_status',
  'list_agents',
  'list_all_references',
  'list_all_rooms',
  'list_bridges',
  'list_linked_rooms',
  'list_machines',
  'list_managed_agents',
  'list_participants',
  'list_reference_types',
  'list_references',
  'list_roles',
  'list_room_groups',
  'list_rooms',
  'list_templates',
  'load_internal_documents',
  'post_message',
  'read_context',
  'send_targeted_message',
]);

/** How far one script may go before it is stopped with an error naming the limit. */
export type ScriptLimits = {
  maxCalls: number;
  deadlineMs: number;
  maxRunMs: number;
  maxOutputChars: number;
  memoryBytes: number;
};

export const SCRIPT_LIMITS: ScriptLimits = {
  maxCalls: 50,
  deadlineMs: 30_000,
  maxRunMs: 500,
  maxOutputChars: 20_000,
  memoryBytes: 64 * 1024 * 1024,
};

/** The operations a script can call, in catalog order. */
export function scriptOperations(operations: SwitchOperation[]): SwitchOperation[] {
  return operations.filter((op) => SCRIPT_OPERATIONS.has(op.name));
}

/** The tool, described with a declaration of every operation a script can call. */
export function runSwitchScriptTool(operations: SwitchOperation[]): ToolDefinition {
  return {
    name: RUN_SWITCH_SCRIPT_TOOL_NAME,
    description: [
      'Run a short async JavaScript body that calls Switch operations, and get back only what it prints.',
      'Use it to chain several Switch calls in one step (read several rooms, filter, then post once) instead of one tool call each.',
      'Call `await ops.<name>(args)` for an operation declared below. Each is the tool of the same name: read that tool for what it does and returns.',
      'Only reading and posting are available here; call every other Switch tool as itself.',
      "A failed operation throws an Error carrying Switch's reason. Print with `text(...values)` or `console.log`; a value the body returns is printed too.",
      'Nothing else is available: no require, imports, fetch, files or timers.',
      `Limits: ${SCRIPT_LIMITS.maxCalls} operation calls, ${SCRIPT_LIMITS.deadlineMs / 1000} seconds in all, ${SCRIPT_LIMITS.maxRunMs} ms of running between operation calls, ${SCRIPT_LIMITS.maxOutputChars} characters of output. Past any of them the script stops with an error that names the limit and lists the calls that completed.`,
      '',
      scriptDeclarations(scriptOperations(operations)),
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description: 'The body of an async function. Use await; print results with text().',
        },
      },
      required: ['code'],
    },
  };
}

/** TypeScript declarations for `ops` and `text`, read off each operation's input schema. */
export function scriptDeclarations(operations: SwitchOperation[]): string {
  const lines = operations.map((op) => {
    const optional =
      !Array.isArray(op.input_schema.required) || op.input_schema.required.length === 0;
    return `  ${op.name}(args${optional ? '?' : ''}: ${schemaType(op.input_schema)}): Promise<unknown>;`;
  });
  return [
    'declare const ops: {',
    ...lines,
    '};',
    'declare function text(...values: unknown[]): void;',
  ].join('\n');
}

type Schema = Record<string, unknown>;

function schemaType(schema: Schema): string {
  if (Array.isArray(schema.anyOf)) return union(schema.anyOf as Schema[]);
  if (Array.isArray(schema.oneOf)) return union(schema.oneOf as Schema[]);
  if (Array.isArray(schema.enum))
    return schema.enum.map((value) => JSON.stringify(value)).join(' | ');
  if ('const' in schema) return JSON.stringify(schema.const);
  if (Array.isArray(schema.type)) {
    return union(schema.type.map((type) => ({ ...schema, type })));
  }
  switch (schema.type) {
    case 'string':
      return 'string';
    case 'integer':
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'null':
      return 'null';
    case 'array': {
      const items = schema.items;
      const item = items && typeof items === 'object' ? schemaType(items as Schema) : 'unknown';
      return item.includes(' | ') ? `(${item})[]` : `${item}[]`;
    }
    case 'object':
      return objectType(schema);
    default:
      return 'unknown';
  }
}

function union(schemas: Schema[]): string {
  return [...new Set(schemas.map(schemaType))].join(' | ');
}

function objectType(schema: Schema): string {
  const properties = (schema.properties ?? {}) as Record<string, Schema>;
  const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);
  const names = Object.keys(properties);
  if (names.length === 0) {
    const extra = schema.additionalProperties;
    if (extra === false) return '{}';
    return `Record<string, ${extra && typeof extra === 'object' ? schemaType(extra as Schema) : 'unknown'}>`;
  }
  const fields = names.map((name) => {
    const key = /^[A-Za-z_$][\w$]*$/.test(name) ? name : JSON.stringify(name);
    return `${key}${required.has(name) ? '' : '?'}: ${schemaType(properties[name])}`;
  });
  return `{ ${fields.join('; ')} }`;
}

/** Runs one operation as the caller of the script. */
export type ScriptOperationRequest = (
  name: string,
  args: Record<string, unknown>
) => Promise<OperationOutcome>;

/**
 * Set up inside QuickJS before any of the script exists. It takes the host
 * functions off the global object, so the body reaches them only through `ops`
 * and `text`, and returns the function that compiles and runs the body. The
 * body is compiled on its own with the `AsyncFunction` constructor, so no text
 * in it can reach back into this. The host checks every call again whatever
 * this does: it is a convenience, not the boundary.
 */
const PRELUDE = `(names) => {
  const call = globalThis.__switch_call;
  const print = globalThis.__switch_print;
  const settle = globalThis.__switch_settle;
  delete globalThis.__switch_call;
  delete globalThis.__switch_print;
  delete globalThis.__switch_settle;
  const render = (value) =>
    typeof value === 'string' ? value : value === undefined ? 'undefined' : JSON.stringify(value, null, 2);
  const plain = (value) =>
    value !== null && typeof value === 'object' &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
  const ops = Object.create(null);
  for (const name of names) {
    ops[name] = async (args = {}) => {
      if (!plain(args)) throw new TypeError(name + ' takes one plain object of arguments');
      return JSON.parse(await call(name, JSON.stringify(args)));
    };
  }
  globalThis.ops = Object.freeze(ops);
  globalThis.text = (...values) => print(values.map(render).join(' '));
  globalThis.console = Object.freeze({ log: globalThis.text });
  const AsyncFunction = (async function () {}).constructor;
  return (code) => {
    let body;
    try {
      body = new AsyncFunction(code);
    } catch (error) {
      settle(String(error));
      return;
    }
    body().then(
      (value) => { if (value !== undefined) globalThis.text(value); settle(''); },
      (error) => settle(String(error) || 'the script threw an empty error'),
    );
  };
}`;

/** The operations whose landing means the script put something in front of the room. */
const SCRIPT_POSTING_OPERATIONS: ReadonlySet<string> = new Set([
  'post_message',
  'send_targeted_message',
]);

let quickjs: Promise<QuickJSWASMModule> | null = null;

function loadQuickJS(): Promise<QuickJSWASMModule> {
  quickjs ??= newQuickJSWASMModuleFromVariant(variant).catch((error: unknown) => {
    quickjs = null;
    throw error;
  });
  return quickjs;
}

/**
 * Run a script body, answering its operation calls with `request`.
 *
 * Every limit stops the script with an error that names it. The lines it
 * printed are kept, and a failure lists the calls that completed and any still
 * in flight, so the agent knows which posts landed before it tries again. The
 * result's fields count the posts that landed and say why any were refused,
 * which is how the session host learns that a turn answered the room.
 *
 * QuickJS runs on this thread, so besides the deadline a script may only run
 * for `maxRunMs` at a stretch before it next waits on an operation: the
 * process also keeps the agent's connection to Switch alive.
 */
export async function runSwitchScript(
  code: string,
  operations: SwitchOperation[],
  limits: ScriptLimits,
  request: ScriptOperationRequest
): Promise<ToolResult> {
  const callable = scriptOperations(operations).map((op) => op.name);
  const allowed = new Set(callable);
  const runtime = (await loadQuickJS()).newRuntime();
  runtime.setMemoryLimit(limits.memoryBytes);
  runtime.setMaxStackSize(1024 * 1024);
  const vm: QuickJSContext = runtime.newContext();

  const printed: string[] = [];
  let printedChars = 0;
  let calls = 0;
  let nextId = 0;
  const completed = new Map<string, number>();
  const inFlight = new Map<number, string>();
  let postsLanded = 0;
  const postFailures: string[] = [];
  // Every deferred the host holds, disposed exactly once: by the call's answer,
  // or at the end for a call still out, whichever comes first.
  const held = new Set<QuickJSDeferredPromise>();
  // How the body itself ended, once it has; the run ends when its calls have too.
  let bodyEnded: { error: string | null } | null = null;
  let failure: string | null = null;
  let finished = false;
  let resolveRun: () => void = () => {};
  const run = new Promise<void>((resolve) => {
    resolveRun = resolve;
  });

  const deadlineAt = Date.now() + limits.deadlineMs;
  const overDeadline = `it ran longer than ${limits.deadlineMs / 1000} seconds`;
  const overRun = `it ran for more than ${limits.maxRunMs} ms without waiting on an operation`;
  let sliceEndsAt = Number.POSITIVE_INFINITY;
  let sliceTripped = false;
  // An interrupt surfaces as an error the script reports: name the limit instead.
  const stop = (reason: string | null) => {
    if (finished) return;
    finished = true;
    failure =
      reason === null
        ? null
        : Date.now() > deadlineAt
          ? overDeadline
          : sliceTripped
            ? overRun
            : reason;
    resolveRun();
  };
  runtime.setInterruptHandler(() => {
    if (finished || Date.now() > deadlineAt) return true;
    if (Date.now() > sliceEndsAt) sliceTripped = true;
    return sliceTripped;
  });
  const deadline = setTimeout(() => stop(overDeadline), limits.deadlineMs);

  /**
   * Let QuickJS run for at most one slice. A tripped slice stops the script
   * here rather than by the error it raises: an interrupt that lands inside a
   * promise reaction only rejects a promise nobody handles.
   */
  const slice = <T>(work: () => T): T => {
    sliceEndsAt = Date.now() + limits.maxRunMs;
    try {
      return work();
    } finally {
      sliceEndsAt = Number.POSITIVE_INFINITY;
      if (sliceTripped) stop(overRun);
    }
  };

  /** Run what the script queued; an interrupt or uncaught job error ends it. */
  const pump = () => {
    if (finished) return;
    const jobs = slice(() => runtime.executePendingJobs());
    if (jobs.error) {
      const reason = describeError(vm.dump(jobs.error));
      jobs.error.dispose();
      stop(reason);
    }
  };

  const endIfDone = () => {
    if (bodyEnded !== null && inFlight.size === 0) stop(bodyEnded.error);
  };

  vm.newFunction('__switch_print', (textHandle) => {
    if (finished) return;
    const line = vm.getString(textHandle);
    const separator = printed.length > 0 ? 1 : 0;
    if (printedChars + separator + line.length > limits.maxOutputChars) {
      const room = limits.maxOutputChars - printedChars - separator;
      if (room > 0) printed.push(line.slice(0, room));
      stop(`it printed more than ${limits.maxOutputChars} characters`);
      return;
    }
    printed.push(line);
    printedChars += separator + line.length;
  }).consume((fn) => vm.setProp(vm.global, '__switch_print', fn));

  vm.newFunction('__switch_settle', (errorHandle) => {
    const error = vm.getString(errorHandle);
    bodyEnded = { error: error === '' ? null : error };
    endIfDone();
  }).consume((fn) => vm.setProp(vm.global, '__switch_settle', fn));

  const answer = (
    id: number,
    name: string,
    deferred: QuickJSDeferredPromise,
    outcome: OperationOutcome
  ) => {
    inFlight.delete(id);
    if (outcome.ok) completed.set(name, (completed.get(name) ?? 0) + 1);
    if (SCRIPT_POSTING_OPERATIONS.has(name)) {
      if (outcome.ok) postsLanded += 1;
      else postFailures.push(outcome.error);
    }
    if (!held.delete(deferred)) return;
    try {
      if (!finished) {
        slice(() => {
          if (outcome.ok) {
            vm.newString(JSON.stringify(outcome.result)).consume((value) =>
              deferred.resolve(value)
            );
          } else {
            vm.newError(outcome.error).consume((error) => deferred.reject(error));
          }
        });
      }
    } finally {
      deferred.dispose();
    }
    pump();
    endIfDone();
  };

  vm.newFunction('__switch_call', (nameHandle, argsHandle) => {
    const name = vm.getString(nameHandle);
    if (finished) return { error: vm.newError('the script has stopped') };
    if (!allowed.has(name)) return { error: vm.newError(`${name} cannot be called from a script`) };
    if (calls >= limits.maxCalls) {
      stop(`it made more than ${limits.maxCalls} operation calls`);
      return { error: vm.newError(`more than ${limits.maxCalls} operation calls`) };
    }
    const args: unknown = JSON.parse(vm.getString(argsHandle));
    if (args === null || typeof args !== 'object' || Array.isArray(args)) {
      return { error: vm.newError(`${name} takes one plain object of arguments`) };
    }
    calls += 1;
    const id = nextId++;
    const deferred = vm.newPromise();
    held.add(deferred);
    inFlight.set(id, name);
    request(name, args as Record<string, unknown>)
      .then((outcome) => answer(id, name, deferred, outcome))
      .catch((error: unknown) => stop(`an answer could not be handed to the script: ${error}`));
    return deferred.handle;
  }).consume((fn) => vm.setProp(vm.global, '__switch_call', fn));

  const prepared = slice(() =>
    vm.evalCode(`(${PRELUDE})(${JSON.stringify(callable)})`, 'run_switch_script.js')
  );
  if (prepared.error) {
    stop(describeError(vm.dump(prepared.error)));
    prepared.error.dispose();
  } else {
    const started = vm
      .newString(code)
      .consume((source) => slice(() => vm.callFunction(prepared.value, vm.undefined, source)));
    prepared.value.dispose();
    if (started.error) {
      stop(describeError(vm.dump(started.error)));
      started.error.dispose();
    } else {
      started.value.dispose();
      pump();
    }
  }

  await run;
  clearTimeout(deadline);
  for (const deferred of held) deferred.dispose();
  held.clear();
  vm.dispose();
  runtime.dispose();

  const posts = { posts_landed: postsLanded, post_failures: postFailures };
  if (failure === null) {
    return { content: [{ type: 'text', text: printed.join('\n') }], structuredContent: posts };
  }
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: [
          ...printed,
          `Script failed: ${failure}`,
          `Calls that completed: ${tally(completed) || 'none'}.`,
          ...(inFlight.size > 0
            ? [
                `Still in flight when it stopped, outcome unknown: ${tally(
                  countNames([...inFlight.values()])
                )}.`,
              ]
            : []),
        ].join('\n'),
      },
    ],
    structuredContent: posts,
  };
}

/** A QuickJS error as `vm.dump` gives it, as one line. */
function describeError(dumped: unknown): string {
  if (dumped !== null && typeof dumped === 'object' && 'message' in dumped) {
    const { name, message } = dumped as { name?: unknown; message?: unknown };
    return `${typeof name === 'string' ? name : 'Error'}: ${String(message)}`;
  }
  return String(dumped);
}

function countNames(names: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
  return counts;
}

function tally(counts: Map<string, number>): string {
  return [...counts].map(([name, count]) => `${name} (${count})`).join(', ');
}
