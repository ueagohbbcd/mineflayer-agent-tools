import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import net from "node:net";
import { spawnSync } from "node:child_process";
import { startRunner } from "../../runtime/host/runner.mjs";
import {
  runModule,
  runPersistentModule,
  runSocket,
} from "../../runtime/host/run.mjs";
import {
  request as rpcRequest,
  session as readSession,
} from "../../runtime/host/rpc.mjs";
import { hostEnv, startBotHosts } from "../../runtime/host/launcher.mjs";
import { LogStore, createLogServer } from "../../runtime/log/index.mjs";
import { socketPath as localSocket } from "../../runtime/socket-path.mjs";

const require = createRequire(import.meta.url);

async function nativeBot() {
  const client = new EventEmitter();
  Object.assign(client, {
    version: "1.21.1",
    state: "play",
    username: "native-test",
    socket: new EventEmitter(),
    write() {},
    writeRaw() {},
    writeChannel() {},
    registerChannel() {},
    unregisterChannel() {},
    chat() {},
    end() {},
  });
  const bot = require("mineflayer").createBot({
    client,
    version: "1.21.1",
    username: "native-test",
    auth: "offline",
    hideErrors: true,
  });
  for (let i = 0; i < 200 && typeof bot.dig !== "function"; i++)
    await delay(10);
  assert.equal(typeof bot.dig, "function", "Mineflayer plugins injected");
  return bot;
}

async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), "runner-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bot = await nativeBot();
  bot.calls = [];
  const clearControlStates = bot.clearControlStates.bind(bot);
  bot.clearControlStates = () => {
    bot.calls.push("clear");
    return clearControlStates();
  };
  bot.pathfinder = { stop: () => bot.calls.push("pathfinder.stop") };
  const runner = await startRunner({
    bot,
    listen: { host: "127.0.0.1", port: 0 },
  });
  t.after(() => runner.close());
  const socketPath = {
    host: "127.0.0.1",
    port: runner.address().port,
  };
  const run = async (source, args = [], options = {}) => {
    const file = join(dir, `task-${Math.random().toString(36).slice(2)}.mjs`);
    await writeFile(file, source);
    const out = new PassThrough(),
      err = new PassThrough();
    let stdout = "",
      stderr = "";
    out.on("data", (c) => (stdout += c));
    err.on("data", (c) => (stderr += c));
    const code = await runModule({
      socketPath,
      file,
      args,
      stdout: out,
      stderr: err,
      signals: options.signals ?? new EventEmitter(),
      env: options.env ?? process.env,
      control: options.control,
    });
    return { code, stdout, stderr };
  };
  return { bot, runner, run, dir, socketPath };
}

async function watchdogLog(t, dir) {
  const socketPath = localSocket(dir, "watchdog-log.sock");
  const store = new LogStore({ dir: join(dir, "log") });
  const entries = [];
  store.on("entry", (entry) => entries.push(entry));
  const server = await createLogServer({ store, socketPath });
  t.after(() => server.close());
  return { entries, env: { MF_LOG_SOCKET: socketPath, MF_TASK_ID: "original-task" } };
}

test("controlling watchdog posts urgent findings with captured identity, deduplicates and resumes after recovery", async (t) => {
  const { run, dir, runner, bot } = await setup(t);
  const { entries, env } = await watchdogLog(t, dir);
  const saved = process.env.MF_CHARACTER;
  process.env.MF_CHARACTER = "original-character";
  let result;
  try {
    result = await run(
      `export const watchdog = { repeatCount: 2, repeatWindowMs: 100, now: () => globalThis.watchdogTestClock };
      export default (bot, { watchdog }) => {
        globalThis.watchdogTestClock = 0;
        process.env.MF_TASK_ID = 'changed-task';
        process.env.MF_CHARACTER = 'changed-character';
        watchdog.failure('no route'); watchdog.failure('no route'); watchdog.failure('no route');
        globalThis.watchdogTestClock = 101;
        watchdog.failure('no route'); watchdog.failure('no route');
        watchdog.pause();
        watchdog.failure('paused'); watchdog.failure('paused');
        watchdog.resume();
        watchdog.failure('paused'); watchdog.failure('paused');
        return 'program survived';
      }`,
      [], { env },
    );
  } finally {
    delete globalThis.watchdogTestClock;
    if (saved === undefined) delete process.env.MF_CHARACTER;
    else process.env.MF_CHARACTER = saved;
  }
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /program survived/);
  assert.equal((result.stdout.match(/\[watchdog\]/g) ?? []).length, 3);
  assert.equal(entries.length, 3, "the completed run flushed its pending posts");
  for (const entry of entries) {
    assert.equal(entry.source, "program-watchdog");
    assert.equal(entry.type, "repeat");
    assert.equal(entry.urgent, true);
    assert.equal(entry.data.urgent, undefined, "urgency belongs to the log entry");
    assert.equal(entry.task, "original-task");
    assert.equal(entry.bot, "original-character");
  }
  assert.deepEqual(entries.map((entry) => entry.data.error), ['no route', 'no route', 'paused']);
  assert.equal(runner.active(), 0);
  assert.equal(bot.listenerCount('path_update'), 0);
});

test("stuck watchdog posts once until movement makes progress again", async (t) => {
  const { run, dir } = await setup(t);
  const { entries, env } = await watchdogLog(t, dir);
  const result = await run(
    `export const watchdog = { stuckMs: 20, checkMs: 5 };
    export default async (bot) => {
      bot.entity = { position: { x: 0, y: 64, z: 0 } };
      bot.setControlState('forward', true);
      await new Promise(resolve => setTimeout(resolve, 100));
      bot.entity.position.x = 2;
      await new Promise(resolve => setTimeout(resolve, 100));
    }`, [], { env },
  );
  assert.equal(result.code, 0, result.stderr);
  assert.equal(entries.length, 2);
  assert.ok(entries.every((entry) => entry.type === 'stuck' && entry.urgent));
  assert.equal((result.stdout.match(/\[watchdog\]/g) ?? []).length, 2);
});

test("read-only and explicitly disabled runs do not install or post a watchdog", async (t) => {
  const { run, dir } = await setup(t);
  const { entries, env } = await watchdogLog(t, dir);
  for (const [declaration, control] of [["export const control = false;", true], ["export const watchdog = false;", true], ["", false]]) {
    const result = await run(
      `${declaration}
      export default (_bot, { watchdog }) => {
        if (watchdog !== undefined) throw new Error('unexpected watchdog');
        return 'disabled';
      }`, [], { env, control },
    );
    assert.equal(result.code, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /\[watchdog\]/);
  }
  assert.deepEqual(entries, []);
});

test("a failed watchdog log post is visible and does not fail or outlive the program", async (t) => {
  const { run, dir, runner } = await setup(t);
  const result = await run(
    `export const watchdog = { repeatCount: 2 };
    export default (_bot, { watchdog }) => {
      watchdog.failure('no route'); watchdog.failure('no route');
      return 'normal completion';
    }`, [], { env: { MF_LOG_SOCKET: localSocket(dir, "missing.sock") } },
  );
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /The same error keeps happening/);
  assert.match(result.stdout, /\[watchdog\] Log delivery failed:/);
  assert.match(result.stdout, /normal completion/);
  assert.equal(runner.active(), 0);
});

test("a module runs on the native bot; its listeners and timers go when it ends", async (t) => {
  const { bot, runner, run } = await setup(t);
  const result = await run(
    `export default async function (bot, { args, log }) {
      bot.on("chat", () => bot.calls.push("late chat"));
      setInterval(() => bot.calls.push("late timer"), 1);
      setTimeout(() => bot.calls.push("late timeout"), 1);
      console.log("hello", args[0]);
      log("count", bot.listenerCount("chat"));
      return { ok: args.length };
    }`,
    ["red"],
  );
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /hello red/);
  assert.match(result.stdout, /count 1/);
  assert.match(result.stdout, /\{"ok":1\}/);
  assert.equal(bot.listenerCount("chat"), 0);
  assert.equal(runner.active(), 0);
  assert.ok(
    bot._client && bot.inventory,
    "the module receives the real Mineflayer bot",
  );
  assert.equal(typeof bot.dig, "function");
  bot.emit("chat");
  await delay(10);
  // A controlling run that returns still lets go of movement.
  assert.deepEqual(bot.calls, ["clear", "pathfinder.stop"]);
  bot.calls.length = 0;

  const failed = await run(
    `export default async () => { throw new Error("boom"); }`,
  );
  assert.equal(failed.code, 1);
  assert.match(failed.stderr, /boom/);
  assert.deepEqual(bot.calls, ["clear", "pathfinder.stop"]);

  const missing = await run(`export const x = 1;`);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /no default export/);
});

test("cancelling a run aborts its signal, removes listeners and stops the bot", async (t) => {
  const { bot, runner, run } = await setup(t);
  const signals = new EventEmitter();
  setTimeout(() => signals.emit("SIGTERM"), 100);
  const result = await run(
    `export default (bot, { signal }) => new Promise((resolve, reject) => {
      bot.once("never", resolve);
      signal.addEventListener("abort", () => reject(signal.reason));
    });`,
    [],
    { signals },
  );
  assert.equal(result.code, 130);
  assert.equal(bot.listenerCount("never"), 0);
  assert.equal(runner.active(), 0);
  assert.deepEqual(bot.calls, ["clear", "pathfinder.stop"]);
});

test("closing the runner cancels an active native module and waits for its cleanup", async (t) => {
  const { bot, runner, run } = await setup(t);
  const running = run(
    `export default (bot, { signal }) => new Promise((resolve, reject) => {
      bot.on("during-close", () => {});
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });`,
  );
  for (let i = 0; i < 100 && runner.active() === 0; i++) await delay(1);
  assert.equal(runner.active(), 1);

  const closing = runner.close();
  const result = await running;
  await closing;
  assert.equal(result.code, 130);
  assert.equal(runner.active(), 0);
  assert.equal(bot.listenerCount("during-close"), 0);
});

test("socket cancellation is idempotent and reports missing runs", async (t) => {
  const bot = new EventEmitter();
  const runner = await startRunner({
    bot,
    listen: { host: "127.0.0.1", port: 0 },
    importModule: async () => ({
      default: (_bot, { signal }) =>
        new Promise((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        ),
    }),
  });
  t.after(() => runner.close());
  const socketPath = { host: "127.0.0.1", port: runner.address().port };
  assert.deepEqual(
    await rpcRequest(socketPath, { type: "cancel", id: "missing" }),
    {
      type: "cancelled",
      found: false,
    },
  );
  const running = rpcRequest(socketPath, {
    type: "run",
    id: "socket-cancel",
    file: "held.mjs",
  });
  for (let i = 0; i < 100 && runner.active() === 0; i++) await delay(1);
  assert.equal(runner.active(), 1);
  assert.deepEqual(
    await rpcRequest(socketPath, { type: "cancel", id: "socket-cancel" }),
    {
      type: "cancelled",
      found: true,
    },
  );
  assert.deepEqual(
    await rpcRequest(socketPath, { type: "cancel", id: "socket-cancel" }),
    {
      type: "cancelled",
      found: false,
    },
  );
  assert.deepEqual(await running, {
    type: "done",
    ok: false,
    cancelled: true,
    value: null,
  });
});

test("session RPC returns snapshots, null for no session, and surfaces reader errors", async (t) => {
  const bot = new EventEmitter();
  let value = { state: "running", sessionId: "s1" };
  let fail = false;
  const runner = await startRunner({
    bot,
    listen: { host: "127.0.0.1", port: 0 },
    readSession: async () => {
      if (fail) throw new Error("session unavailable");
      return value;
    },
  });
  t.after(() => runner.close());
  const socketPath = { host: "127.0.0.1", port: runner.address().port };
  assert.deepEqual(await readSession(socketPath), {
    type: "session",
    session: { state: "running", sessionId: "s1" },
  });
  value = undefined;
  assert.deepEqual(await readSession(socketPath), {
    type: "session",
    session: null,
  });
  fail = true;
  await assert.rejects(readSession(socketPath), /session unavailable/);
});

test("a persistent default task resumes after its native host restarts", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "persistent-run-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "once.mjs");
  await writeFile(file, `export default () => "resumed";`);
  const probe = net.createServer();
  probe.listen(0, "127.0.0.1");
  await new Promise((resolve) => probe.once("listening", resolve));
  const socketPath = {
    host: "127.0.0.1",
    port: probe.address().port,
  };
  await new Promise((resolve) => probe.close(resolve));

  const running = runPersistentModule({ socketPath, file });
  await delay(100);
  const runner = await startRunner({
    bot: new EventEmitter(),
    listen: socketPath,
  });
  t.after(() => runner.close());
  assert.equal(await running, 0);
});

test("SIGTERM while a persistent host is unavailable exits as cancelled", async () => {
  const probe = net.createServer();
  probe.listen(0, "127.0.0.1");
  await new Promise((resolve) => probe.once("listening", resolve));
  const socketPath = {
    host: "127.0.0.1",
    port: probe.address().port,
  };
  await new Promise((resolve) => probe.close(resolve));
  class ImmediateSignal extends EventEmitter {
    on(name, listener) {
      super.on(name, listener);
      if (name === "SIGTERM") queueMicrotask(() => this.emit(name));
      return this;
    }
  }
  const signals = new ImmediateSignal();
  const running = runPersistentModule({
    socketPath,
    file: "/tmp/never-run.mjs",
    signals,
  });
  assert.equal(await running, 130);
});

test("bot hosts: one native process and run socket per character", async (t) => {
  const env = {
    ARENA_MINECRAFT_HOST: "mc.local",
    ARENA_BOT: "arena_red1",
    PATH: "/usr/bin",
  };
  const runSocketPath = "/tmp/r/arena_red1.sock";
  const one = hostEnv(env, {
    name: "arena_red1",
    index: 1,
    runSocket: runSocketPath,
    runDir: "/tmp/r",
  });
  assert.equal(one.MF_USERNAME, "arena_red1");
  assert.equal(one.MF_RUN_SOCKET, runSocketPath);
  assert.equal(one.MF_BOT_INDEX, "1");
  assert.equal(one.BRIDGE_URL, undefined);
  assert.equal(one.BRIDGE_TOKEN, undefined);

  const dir = await mkdtemp(join(tmpdir(), "hosts-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const started = [];
  const children = [];
  const hosts = await startBotHosts({
    env,
    names: ["arena_red1", "arena_red2"],
    runDir: join(dir, "run"),
    restartMs: 10,
    spawnHost: (environment) => {
      started.push(environment.MF_USERNAME);
      const child = new EventEmitter();
      child.kill = () => {};
      children.push(child);
      return child;
    },
    log: () => {},
  });
  t.after(() => hosts.close());
  assert.deepEqual(started, ["arena_red1", "arena_red2"]);
  assert.equal(hosts.env.MF_RUN_SOCKET, join(dir, "run", "arena_red1.sock"));
  assert.equal(hosts.env.ARENA_BRIDGE_URL, undefined);
  assert.equal(hosts.env.ARENA_BRIDGE_TOKEN, undefined);
  assert.equal(
    runSocket("arena_red2", hosts.env),
    join(dir, "run", "arena_red2.sock"),
  );
  assert.deepEqual(
    JSON.parse(
      await (
        await import("node:fs/promises")
      ).readFile(hosts.env.MF_BOTS_FILE, "utf8"),
    ),
    {
      bots: [
        { name: "arena_red1", runSocket: join(dir, "run", "arena_red1.sock") },
        { name: "arena_red2", runSocket: join(dir, "run", "arena_red2.sock") },
      ],
    },
  );
  assert.throws(() => runSocket("arena_blue1", hosts.env), /not one of/);
  children[0].emit("exit", 1, null);
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(started, ["arena_red1", "arena_red2", "arena_red1"]);
});

test("a run sees its own task's log identity in process.env", async (t) => {
  const { run } = await setup(t);
  const { runEnv } = await import("../../runtime/host/run.mjs");
  assert.deepEqual(
    runEnv({ MF_TASK_ID: "t1", MF_TASK_LOG_DIR: "/l", MF_LOG_SOCKET: "/s", SECRET: "x" }),
    { MF_TASK_ID: "t1", MF_TASK_LOG_DIR: "/l", MF_LOG_SOCKET: "/s" },
  );
  const before = process.env.MF_TASK_ID;
  process.env.MF_TASK_ID = "outer";
  t.after(() => {
    if (before === undefined) delete process.env.MF_TASK_ID;
    else process.env.MF_TASK_ID = before;
  });
  const result = await run(
    `export default async () => process.env.MF_TASK_ID;`,
  );
  // runModule sends this process's MF_TASK_ID ("outer") as the run's.
  assert.match(result.stdout, /"outer"/);
});

test("a controlling run gets the watchdog: findings in its own output; it can be turned off", async (t) => {
  const { bot, run } = await setup(t);
  const { Vec3 } = require("vec3");
  bot.entity = { position: new Vec3(0, 64, 0), isCollidedHorizontally: true };
  const pushing = `
    export default async function (bot, { watchdog }) {
      console.log("has watchdog", typeof watchdog?.failure);
      bot.setControlState("forward", true);
      bot.entity.position = bot.entity.position.clone();
      await new Promise((done) => setTimeout(done, 300));
    }`;
  const watched = await run(`export const watchdog = { stuckMs: 100, checkMs: 20 };${pushing}`);
  assert.equal(watched.code, 0, watched.stderr);
  assert.match(watched.stdout, /has watchdog function/);
  assert.match(watched.stdout, /\[watchdog\] Trying to move \(forward\) but moved less than 1 block in 0 s, pressed against a wall\./);
  const off = await run(`export const watchdog = false;${pushing}`);
  assert.match(off.stdout, /has watchdog undefined/);
  assert.doesNotMatch(off.stdout, /\[watchdog\]/);
  const readOnly = await run(`export const control = false; export const watchdog = { stuckMs: 100, checkMs: 20 };${pushing}`);
  assert.doesNotMatch(readOnly.stdout, /\[watchdog\]/);
});

test("cancellation hard-terminates a host when a module ignores AbortSignal", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "unresponsive-host-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const moduleFile = join(dir, "ignores-abort.mjs");
  await writeFile(moduleFile, `export default () => new Promise(() => {});`);
  const runnerUrl = new URL("../../runtime/host/runner.mjs", import.meta.url);
  const runUrl = new URL("../../runtime/host/run.mjs", import.meta.url);
  const childSource = `
    import { EventEmitter } from "node:events";
    import { startRunner } from ${JSON.stringify(runnerUrl.href)};
    import { runModule } from ${JSON.stringify(runUrl.href)};
    const signals = new EventEmitter();
    const runner = await startRunner({ bot: new EventEmitter(), listen: { host: "127.0.0.1", port: 0 }, cancellationGraceMs: 40 });
    const socketPath = { host: "127.0.0.1", port: runner.address().port };
    setTimeout(() => signals.emit("SIGTERM"), 30);
    await runModule({ socketPath, file: ${JSON.stringify(moduleFile)}, signals });
  `;
  const child = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", childSource],
    {
      encoding: "utf8",
      timeout: 5000,
    },
  );
  assert.equal(child.status, 75, child.stderr);
});

test("RPC consumer errors reject with the host's explicit error", async (t) => {
  const listen = { host: "127.0.0.1", port: 0 };
  const server = net.createServer((socket) => {
    socket.once("data", () => {
      socket.end(
        `${JSON.stringify({ type: "error", error: "consumer failed" })}\n`,
      );
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(listen, resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const address = server.address();
  await assert.rejects(
    rpcRequest(
      { host: address.address, port: address.port },
      { type: "status" },
    ),
    /consumer failed/,
  );
});

test("a probe says whether a module controls the character, and its run reuses the import", async (t) => {
  const { bot, dir, socketPath } = await setup(t);
  const file = join(dir, "helper.mjs");
  // Counts its imports in a global: a second import would count 2.
  await writeFile(
    file,
    `globalThis.helperImports = (globalThis.helperImports ?? 0) + 1;
    const control = false;
    export { control };
    export default async () => globalThis.helperImports;`,
  );
  const answer = await rpcRequest(socketPath, { type: "probe", file });
  assert.equal(answer.control, false, "an export list counts, not only `export const`");
  const out = new PassThrough();
  let stdout = "";
  out.on("data", (c) => (stdout += c));
  const code = await runModule({ socketPath, file, stdout: out, stderr: new PassThrough(), signals: new EventEmitter() });
  assert.equal(code, 0);
  assert.match(stdout, /^1$/m, "one import for the probe and the run");
  assert.deepEqual(bot.calls, [], "a read-only module leaves movement alone");

  const controlling = join(dir, "walk.mjs");
  await writeFile(controlling, `export default async () => {};`);
  assert.equal((await rpcRequest(socketPath, { type: "probe", file: controlling })).control, true);
  const broken = join(dir, "broken.mjs");
  await writeFile(broken, `export default (;`);
  const failed = await rpcRequest(socketPath, { type: "probe", file: broken });
  assert.equal(failed.control, true);
  assert.ok(failed.error);
});

test("a run started read-only leaves movement alone", async (t) => {
  const { bot, dir, socketPath } = await setup(t);
  const file = join(dir, "look.mjs");
  await writeFile(file, `export default async () => {};`);
  const code = await runModule({
    socketPath,
    file,
    control: false,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    signals: new EventEmitter(),
  });
  assert.equal(code, 0);
  assert.deepEqual(bot.calls, []);
});

test("world memory settings: MF_ names, older ARENA_ names still read", async () => {
  const { worldMemoryOptions } =
    await import("../../runtime/host/world-memory.mjs");
  assert.equal(worldMemoryOptions({}, "a"), null);
  const mf = worldMemoryOptions(
    { MF_WORLD_MEMORY_DIR: "/m", MF_WORLD_ID: "w" },
    "a",
  );
  assert.equal(mf.directory, "/m");
  assert.equal(JSON.parse(mf.worldId).worldId, "w");
  const old = worldMemoryOptions({ ARENA_WORLD_MEMORY_DIR: "/o" }, "a");
  assert.equal(old.directory, "/o");
  assert.equal(
    worldMemoryOptions(
      {
        MF_WORLD_MEMORY_MODE: "session",
        ARENA_WORLD_MEMORY_MODE: "persistent",
      },
      "a",
    ).directory,
    undefined,
  );
});
