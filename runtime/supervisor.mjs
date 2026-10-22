/**
 * The supervisor: one process per agent that owns everything around the
 * characters' Mineflayer processes, so that it keeps working when a
 * character's process is blocked or restarting.
 *
 * - the report queue (inbox) that programs post to with InboxClient;
 * - one bot host (host/cli.mjs, the real Mineflayer bot) per character,
 *   restarted when it exits;
 * - programs, run as tasks with log files (host/run.mjs inside bash);
 * - the default read-only scripts (observer, chat, trend watchdog);
 * - the idle behaviour between the model's programs;
 * - a control socket that bin/mf.mjs talks to.
 *
 * One step: `run` starts a program and waits until it ends, is interrupted,
 * or returns early (its wait time is up, it made no progress, or a report
 * needs the model's attention); the result carries every report queued since
 * the last result. See runtime/README.md.
 */
import { existsSync, statSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { basename, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Inbox, createInboxServer } from "./inbox/index.mjs";
import { TaskManager } from "./tasks/index.mjs";
import { startBotHosts } from "./host/launcher.mjs";
import { createMotionProbe } from "./host/motion-probe.mjs";
import { status as hostStatus } from "./host/rpc.mjs";

const here = (path) => fileURLToPath(new URL(path, import.meta.url));
const runScript = here("./host/run.mjs");
const builtinIdle = here("./default-scripts/idle.mjs");
const snapshotScript = here("./default-scripts/snapshot.mjs");
const defaultScriptFiles = {
  observer: here("./default-scripts/observer.mjs"),
  chat: here("./default-scripts/chat.mjs"),
  watchdog: here("./default-scripts/watchdog.mjs"),
};
const WEEK_MS = 7 * 24 * 3600 * 1000;
// Programs import the toolkit from here: `${process.env.MF_TOOLKIT_ROOT}/runtime/...`.
const toolkitRoot = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");

/** Reports that make the model's current plan stale: the program is stopped. */
export function majorReason(message) {
  const data = message?.data;
  if (!data || typeof data !== "object") return null;
  if (data.type === "observation.death") return "death";
  if (data.type === "observation.disconnected") return "disconnected";
  if (data.type === "host.crashed") return "host crashed";
  if (message.kind === "judgment" && data.type === "blocked") return "blocked";
  return null;
}

const quote = (value) => `'${String(value).replace(/'/g, "'\\''")}'`;
const KEEP_TASK_DIRS = 100;

/** Remove a socket file left by a supervisor that is gone; a live one is an error. */
async function claimSocket(path) {
  const live = await new Promise((done) => {
    const socket = net.connect(path);
    socket.once("connect", () => {
      socket.destroy();
      done(true);
    });
    socket.once("error", () => done(false));
  });
  if (live) throw new Error(`Another supervisor is listening on ${path}`);
  await rm(path, { force: true });
}

async function prepareTaskDir(dir) {
  await mkdir(dir, { recursive: true });
  // Keep the newest task directories of earlier supervisors.
  const entries = (await readdir(dir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      name: entry.name,
      mtime: statSync(join(dir, entry.name), { throwIfNoEntry: false })?.mtimeMs ?? 0,
    }))
    .sort((a, b) => b.mtime - a.mtime);
  for (const { name } of entries.slice(KEEP_TASK_DIRS))
    await rm(join(dir, name), { recursive: true, force: true });
  // Tasks still marked running belong to an earlier supervisor that is gone.
  for (const { name } of entries.slice(0, KEEP_TASK_DIRS)) {
    const path = join(dir, name, "status.json");
    try {
      const status = JSON.parse(await readFile(path, "utf8"));
      if (status.status === "running")
        await writeFile(
          path,
          `${JSON.stringify({ ...status, status: "lost" }, null, 2)}\n`,
        );
    } catch {
      /* Unreadable leftovers are left as they are. */
    }
  }
}

export async function startSupervisor({
  cwd = process.cwd(),
  env = process.env,
  stateDir = env.MF_STATE_DIR || join(cwd, ".mf"),
  names,
  defaultScripts = (env.MF_DEFAULT_SCRIPTS ?? "observer,chat,watchdog")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean),
  idle: idleEnabled = env.MF_IDLE !== "off",
  waitSeconds = Number(env.MF_WAIT_SECONDS ?? 30),
  stallSeconds = Number(env.MF_STALL_SECONDS ?? 20),
  // Longer than run.mjs's grace for a stuck module (it then stops the host),
  // so a replaced program has really let go of the bot before the next starts.
  killGraceMs = 5000,
  log = (line) => process.stderr.write(`${line}\n`),
} = {}) {
  for (const name of defaultScripts)
    if (!defaultScriptFiles[name])
      throw new Error(`Unknown default script: ${name}`);
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const gitignore = join(stateDir, ".gitignore");
  if (!existsSync(gitignore)) await writeFile(gitignore, "*\n");
  const sessionId = env.MC_INBOX_SESSION || `mf-${Date.now()}`;
  const inboxSocket = join(stateDir, "inbox.sock");
  const controlSocket = join(stateDir, "control.sock");
  await claimSocket(controlSocket);
  await claimSocket(inboxSocket);
  // Reports wait until the model receives them; only the size limit drops them.
  const inbox = new Inbox({ sessionId, ttlMs: WEEK_MS });
  const inboxServer = await createInboxServer({
    inbox,
    socketPath: inboxSocket,
  });
  const inboxEnv = {
    MC_INBOX_SESSION: sessionId,
    MC_INBOX_SOCKET: inboxSocket,
    MF_TOOLKIT_ROOT: toolkitRoot,
  };

  // Until when a host exit is the expected result of stopping one of its
  // programs, per character.
  const cancelling = new Map();
  let hosts;
  try {
    hosts = await startBotHosts({
      env: { ...env, ...inboxEnv },
      ...(names ? { names } : {}),
      runDir: join(stateDir, "bots"),
      log,
      onExit(host, { code, signal }) {
        // A program that ignores cancellation gets its host killed (SIGKILL by
        // run.mjs, or exit 75 from the host itself); any other exit is a
        // crash that the model has to hear about.
        const expected =
          (signal === "SIGKILL" || code === 75) &&
          Date.now() < (cancelling.get(host.name) ?? 0);
        inbox.post(
          {
            sessionId,
            kind: "event",
            priority: expected ? "normal" : "urgent",
            data: {
              type: expected ? "host.restarted" : "host.crashed",
              bot: host.name,
              exit: signal ?? code,
            },
          },
          { source: "runtime" },
        );
      },
    });
  } catch (error) {
    await inboxServer.close();
    throw error;
  }
  const sockets = new Map(hosts.bots.map((bot) => [bot.name, bot.runSocket]));
  const mainBot = hosts.bots[0].name;
  const taskDir = join(stateDir, "tasks");
  const tasks = new TaskManager({
    inbox,
    cwd,
    env: { ...inboxEnv, ...hosts.env, ARENA_TASK_DIR: taskDir },
    logDir: taskDir,
    killGraceMs,
  });
  // The character each task runs on.
  const taskBots = new Map();

  const socketOf = (bot) => {
    const socket = sockets.get(bot ?? mainBot);
    if (!socket) throw new Error(`Unknown character ${bot}; characters: ${[...sockets.keys()].join(", ")}`);
    return socket;
  };
  async function hostReady(bot, timeoutMs = 60000) {
    const socket = socketOf(bot);
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        await hostStatus(socket);
        return;
      } catch (error) {
        if (Date.now() > deadline)
          throw new Error(`Character ${bot ?? mainBot} is not ready: ${error.message}`);
        await new Promise((done) => setTimeout(done, 250));
      }
    }
  }
  const moduleCommand = (file, { args = [], bot, persistent } = {}) =>
    [
      quote(process.execPath),
      quote(runScript),
      ...(persistent ? ["--persistent"] : []),
      ...(bot ? ["--bot", quote(bot)] : []),
      quote(file),
      ...args.map(quote),
    ].join(" ");
  function startTask(file, { bot, args, persistent, ...options }) {
    const id = tasks.start(moduleCommand(file, { args, bot, persistent }), options);
    taskBots.set(id, bot ?? mainBot);
    return id;
  }
  const completion = (id) =>
    new Promise((done) => {
      const task = tasks.tasks.get(id);
      if (!task || task.status === "completed") return done(task);
      task.child.once("close", () => setImmediate(() => done(task)));
    });
  // Routine runs (idle, snapshots) leave no task directory behind.
  const forget = (id) => {
    const dir = tasks.tasks.get(id)?.logDir;
    if (dir) void rm(dir, { recursive: true, force: true });
  };

  // One controlling program at a time: the model's current one, or idle.
  let controller = null;
  let idleTask = null;
  let takingOver = null;
  // Programs between takeOver() and becoming the controller; idle waits.
  let starting = 0;
  let major = null;
  let closed = false;

  inbox.on("message", (message) => {
    const reason = majorReason(message);
    if (!reason) return;
    major ??= { reason, at: Date.now() };
    const task = controller && tasks.tasks.get(controller);
    if (task?.status === "running" && !task.interruptReason) {
      task.interruptReason = reason;
      cancelTask(controller);
    }
  });

  function cancelTask(id) {
    const bot = taskBots.get(id) ?? mainBot;
    cancelling.set(bot, Date.now() + killGraceMs + 5000);
    try {
      tasks.cancel(id);
    } catch {}
  }

  /** Stop the controlling program and idle, and wait until both are gone. */
  async function takeOver() {
    while (takingOver) await takingOver;
    let release;
    takingOver = new Promise((done) => (release = done));
    try {
      const ids = [];
      if (controller) {
        const task = tasks.tasks.get(controller);
        if (task?.status === "running") {
          task.interruptReason ??= "replaced by a new program";
          ids.push(controller);
        }
      }
      if (idleTask) {
        idleTask.cancelled = true;
        ids.push(idleTask.id);
      }
      for (const id of ids) cancelTask(id);
      await Promise.all(ids.map(completion));
    } finally {
      takingOver = null;
      release();
    }
  }

  let idleCustomFailed = null;
  let idleTimer;
  const idleBlocked = () => closed || controller || idleTask || takingOver || starting;
  function scheduleIdle(delayMs = 0) {
    if (!idleEnabled || closed) return;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => void startIdle(), delayMs);
  }
  async function startIdle() {
    if (idleBlocked()) return;
    try {
      await hostReady();
    } catch (error) {
      log(`idle: ${error.message}`);
      return scheduleIdle(5000);
    }
    if (idleBlocked()) return;
    // A workdir idle.mjs is loaded fresh each time; after it fails, the
    // built-in one runs until the file changes.
    const custom = join(cwd, "idle.mjs");
    let file = builtinIdle;
    if (existsSync(custom)) {
      const mtime = statSync(custom).mtimeMs;
      if (idleCustomFailed !== mtime) file = custom;
    }
    const id = startTask(file, {
      cwd,
      label: file === builtinIdle ? "idle (built-in)" : "idle (idle.mjs)",
      background: true,
    });
    const entry = { id, file, cancelled: false };
    idleTask = entry;
    const task = tasks.tasks.get(id);
    task.child.once("close", (code) => {
      if (idleTask === entry) idleTask = null;
      // Idle ending is routine; only a failure (below) is worth a report.
      if (task.eventId) inbox.remove(task.eventId);
      task.delivered = true;
      forget(id);
      if (entry.cancelled || closed) return;
      if (code === 75) return scheduleIdle(1000); // Host restarting.
      const stderr = task.stderr.toString("utf8").slice(-600);
      inbox.post(
        {
          sessionId,
          kind: "event",
          data: {
            type: "idle.failed",
            file,
            exitCode: code,
            stderr,
            ...(file === builtinIdle ? {} : { fallback: "built-in idle" }),
          },
        },
        { source: "runtime" },
      );
      if (file !== builtinIdle) {
        idleCustomFailed = statSync(file, { throwIfNoEntry: false })?.mtimeMs ?? null;
        scheduleIdle(0);
      } else scheduleIdle(5000);
    });
  }

  /** Every result carries the reports queued since the previous result. */
  function deliver(result) {
    const batch = inbox.drain();
    tasks.resumeWaits();
    major = null;
    return {
      ...result,
      reports: batch.messages.map(
        ({ id, sessionId: _, expiresAt, eligibleAt, ...message }) => {
          const label = message.taskId && tasks.tasks.get(message.taskId)?.label;
          // A program that ended unwatched says why it was stopped.
          const stopped =
            message.data?.type === "task.completed" &&
            tasks.tasks.get(message.data.taskId)?.interruptReason;
          return {
            ...message,
            ...(label ? { from: label } : {}),
            ...(stopped ? { data: { ...message.data, interrupted: stopped } } : {}),
          };
        },
      ),
      ...(batch.dropped.overflow ? { droppedReports: batch.dropped.overflow } : {}),
    };
  }

  async function waitTask(id, { wait, stall, signal }) {
    const timeoutMs = Math.max(0, wait ?? waitSeconds) * 1000;
    const stallMs = Math.max(0, stall ?? stallSeconds) * 1000;
    const probe =
      stallMs > 0 && stallMs < timeoutMs
        ? createMotionProbe({ socketPath: socketOf(taskBots.get(id)) })
        : undefined;
    let result;
    try {
      result = await tasks.wait(id, {
        timeoutMs,
        stallMs,
        progress: probe?.key,
        signal,
      });
    } finally {
      probe?.close();
    }
    const task = tasks.tasks.get(id);
    if (task?.interruptReason) {
      if (result.status === "running") {
        tasks.resumeWaits();
        result = await tasks.wait(id, { timeoutMs: killGraceMs + 10000, signal });
      }
      result = { ...result, status: "interrupted", reason: task.interruptReason };
    }
    return result;
  }

  async function run(request, signal) {
    if (typeof request.file !== "string" || !request.file)
      throw new Error("run needs a module file");
    socketOf(request.bot); // An unknown character fails before anything stops.
    const cwdOf = request.cwd || cwd;
    const file = isAbsolute(request.file) ? request.file : resolve(cwdOf, request.file);
    if (!existsSync(file)) throw new Error(`No such module: ${file}`);
    // A module that declares itself read-only runs beside the controller.
    const background =
      request.background === true ||
      /^export\s+const\s+control\s*=\s*false\b/m.test(await readFile(file, "utf8"));
    const start = () =>
      startTask(file, {
        args: request.args ?? [],
        bot: request.bot,
        cwd: cwdOf,
        label: basename(file),
        background,
      });
    if (background) {
      await hostReady(request.bot);
      return waitTask(start(), { ...request, signal });
    }
    if (major)
      return {
        status: "not_started",
        reason: `${major.reason} since your last result; the program was not started`,
      };
    starting++;
    let id;
    try {
      await takeOver();
      await hostReady(request.bot);
      id = start();
      controller = id;
    } finally {
      starting--;
      if (!id) scheduleIdle(0);
    }
    tasks.tasks.get(id).child.once("close", () => {
      if (controller === id) {
        controller = null;
        scheduleIdle(0);
      }
    });
    return waitTask(id, { ...request, signal });
  }

  async function snapshot(request) {
    await hostReady(request.bot);
    const id = startTask(snapshotScript, {
      args: request.args ?? [],
      bot: request.bot,
      cwd: request.cwd || cwd,
      label: "snapshot",
      background: true,
    });
    // Pending urgent reports are for the model's programs, not this read.
    const result = await tasks.wait(id, { timeoutMs: 15000, urgent: false });
    if (result.status !== "completed") cancelTask(id);
    await completion(id);
    const task = tasks.tasks.get(id);
    if (task?.eventId) inbox.remove(task.eventId);
    if (task) task.delivered = true;
    // A cut snapshot keeps its log directory, where the whole output is.
    if (!result.outputDroppedBytes) forget(id);
    return result;
  }

  function status() {
    const running = [...tasks.tasks.values()]
      .filter((task) => task.status === "running")
      .map((task) => ({
        taskId: task.id,
        label: task.label ?? task.command.slice(0, 80),
        character: taskBots.get(task.id),
        role:
          task.id === controller
            ? "controlling"
            : task.id === idleTask?.id
              ? "idle"
              : "background",
        startedAt: task.startedAt,
        ...(task.logDir ? { logDir: task.logDir } : {}),
      }));
    return {
      status: "status",
      sessionId,
      characters: hosts.bots.map(({ name, pid }) => ({ name, running: Boolean(pid) })),
      tasks: running,
      // What programs set with InboxClient.setStatus.
      programStatus: inbox.currentSnapshot(),
      pendingReports: inbox.items.length,
    };
  }

  async function handle(request, signal) {
    switch (request.type) {
      case "run":
        return deliver(await run(request, signal));
      case "wait":
        if (typeof request.taskId !== "string") throw new Error("wait needs a taskId");
        return deliver(await waitTask(request.taskId, { ...request, signal }));
      case "cancel": {
        if (typeof request.taskId !== "string") throw new Error("cancel needs a taskId");
        const task = tasks.get(request.taskId);
        if (task.status === "running") {
          if (request.taskId === controller) task.interruptReason ??= "cancelled";
          cancelTask(request.taskId);
          await completion(request.taskId);
        }
        return deliver(await waitTask(request.taskId, { wait: 0, stall: 0 }));
      }
      case "events":
        return deliver({ status: "events" });
      case "status":
        return status();
      case "snapshot":
        return snapshot(request);
      case "shutdown":
        setImmediate(() => void close());
        return { status: "stopping", pid: process.pid };
      default:
        throw new Error(`Unknown request type ${request.type}`);
    }
  }

  const clients = new Set();
  const control = net.createServer((client) => {
    let buffer = "";
    const detached = new AbortController();
    clients.add(client);
    client.setEncoding("utf8");
    client.on("error", () => {});
    client.on("close", () => {
      clients.delete(client);
      detached.abort();
    });
    client.on("data", (chunk) => {
      if (buffer === null) return;
      buffer += chunk;
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      const line = buffer.slice(0, end);
      buffer = null;
      let request;
      try {
        request = JSON.parse(line);
      } catch {
        return client.end(`${JSON.stringify({ status: "error", error: "Bad request" })}\n`);
      }
      handle(request, detached.signal).then(
        (response) => {
          if (!client.destroyed) client.end(`${JSON.stringify(response)}\n`);
        },
        (error) => {
          if (!client.destroyed)
            client.end(`${JSON.stringify({ status: "error", error: error.message })}\n`);
        },
      );
    });
  });

  let markClosed;
  const whenClosed = new Promise((done) => (markClosed = done));
  async function close() {
    if (closed) return whenClosed;
    closed = true;
    clearTimeout(idleTimer);
    // Callers still waiting on a result are cut off rather than waited for.
    for (const client of clients) client.destroy();
    if (control.listening) await new Promise((done) => control.close(() => done()));
    await rm(controlSocket, { force: true });
    // The characters stop their own programs as they quit; the tasks that ran
    // them then end on their own.
    hosts.close();
    await tasks.close();
    await inboxServer.close();
    markClosed();
  }

  let defaults;
  try {
    await prepareTaskDir(taskDir);
    await hostReady();
    // Every character gets the default scripts; idle and the controlling
    // program are shared (see runtime/README.md).
    defaults = new Map();
    for (const name of defaultScripts)
      for (const bot of sockets.keys())
        defaults.set(
          sockets.size > 1 ? `${name}:${bot}` : name,
          startTask(defaultScriptFiles[name], {
            persistent: true,
            bot: sockets.size > 1 ? bot : undefined,
            label: sockets.size > 1 ? `default ${name} (${bot})` : `default ${name}`,
            background: true,
          }),
        );
    // `mf start` reports success once this socket answers.
    await new Promise((done, fail) => {
      control.once("error", fail);
      control.listen(controlSocket, done);
    });
  } catch (error) {
    await close();
    throw error;
  }
  scheduleIdle(0);

  // Resolves once the supervisor has shut down (after close() or `mf stop`).
  return { controlSocket, inbox, tasks, defaults, hosts, close, closed: whenClosed, handle };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const supervisor = await startSupervisor();
  process.stdout.write(`Supervisor ready: ${supervisor.controlSocket}\n`);
  void supervisor.closed.then(() => process.exit(0));
  process.once("SIGTERM", () => void supervisor.close());
  process.once("SIGINT", () => void supervisor.close());
}
