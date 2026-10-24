/**
 * The supervisor: one process per agent that owns everything around the
 * characters' Mineflayer processes, so that it keeps working when a
 * character's process is blocked or restarting.
 *
 * - the log (log/), that programs and modules write to with LogClient and
 *   that `mf log` reads straight from its files;
 * - one bot host (host/cli.mjs, the real Mineflayer bot) per character,
 *   restarted when it exits;
 * - programs, run as tasks with log files (host/run.mjs inside bash);
 * - the default read-only modules (chat by default; danger, radar, explore
 *   and watchdog on request, see MF_DEFAULT_SCRIPTS);
 * - the idle behaviour between the model's programs;
 * - a control socket that bin/mf.mjs talks to.
 *
 * `run` starts a program, streams its output and waits until it ends, is
 * interrupted, or an urgent log entry arrives (then it returns early with
 * the reason only, and the program goes on). See runtime/README.md.
 *
 * A stop is a log entry whose data carries `stop: "reason"`. The supervisor
 * writes them itself (source `runtime`) for death, a new dimension, a
 * session change, a disconnect and a crashed or unresponsive process (from
 * the character's process over an internal channel, so they hold with every
 * module turned off); a program may write one too. A stop interrupts the
 * character's controlling program; the next `mf run` on that character
 * starts by printing the stops it has not shown yet.
 *
 * Each character has its own controlling program, idle behaviour and
 * takeover lock.
 */
import { existsSync, statSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { basename, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { LogStore, createLogServer } from "./log/index.mjs";
import { readCursor } from "./log/view.mjs";
import { TaskManager } from "./tasks/index.mjs";
import { startBotHosts } from "./host/launcher.mjs";
import { StringDecoder } from "node:string_decoder";
import { request as hostRequest, status as hostStatus } from "./host/rpc.mjs";
import { socketPath } from "./socket-path.mjs";

const here = (path) => fileURLToPath(new URL(path, import.meta.url));
const runScript = here("./host/run.mjs");
const builtinIdle = here("./default-scripts/idle.mjs");
const snapshotScript = here("./default-scripts/snapshot.mjs");
const defaultScriptFiles = {
  chat: here("./default-scripts/chat.mjs"),
  danger: here("./default-scripts/danger.mjs"),
  radar: here("./default-scripts/radar.mjs"),
  explore: here("./default-scripts/explore.mjs"),
  watchdog: here("./default-scripts/watchdog.mjs"),
};
// Programs import the toolkit from here: `${process.env.MF_TOOLKIT_ROOT}/runtime/...`.
const toolkitRoot = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");

/**
 * The stop a log entry carries: `stop: "reason"` in its data. Such an entry
 * makes the model's plan stale: the character's program is stopped.
 */
export function stopReason(entry) {
  const stop = entry?.data?.stop;
  return typeof stop === "string" && stop ? stop.slice(0, 120) : null;
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
  defaultScripts = (env.MF_DEFAULT_SCRIPTS ?? "chat")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean),
  idle: idleEnabled = env.MF_IDLE !== "off",
  // Longer than run.mjs's grace for a stuck module (it then stops the host),
  // so a replaced program has really let go of the bot before the next starts.
  killGraceMs = 5000,
  // A character's process that sends no heartbeat for this long is killed
  // and restarted (MF_HOST_UNRESPONSIVE_SECONDS; 0 turns it off).
  unresponsiveMs = Number(env.MF_HOST_UNRESPONSIVE_SECONDS ?? 20) * 1000,
  // A source's log file moves to <source>.1.jsonl past this size.
  logFileBytes = Number(env.MF_LOG_FILE_BYTES ?? 20_000_000),
  log = (line) => process.stderr.write(`${line}\n`),
} = {}) {
  for (const name of defaultScripts)
    if (!defaultScriptFiles[name])
      throw new Error(`Unknown default script: ${name}`);
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const gitignore = join(stateDir, ".gitignore");
  if (!existsSync(gitignore)) await writeFile(gitignore, "*\n");
  const sessionId = `mf-${Date.now()}`;
  const logSocket = socketPath(resolve(stateDir), "log.sock");
  const controlSocket = socketPath(resolve(stateDir), "control.sock");
  await claimSocket(controlSocket);
  await claimSocket(logSocket);
  const logDir = join(stateDir, "log");
  const store = new LogStore({
    dir: logDir,
    maxFileBytes: logFileBytes,
    onError: (error) => log(`log: ${error.message}`),
  });
  // Entries since this supervisor started, per source: seq and urgency, for
  // the "unread" line under every result.
  const recent = new Map();
  store.on("entry", (entry) => {
    if (!recent.has(entry.source)) recent.set(entry.source, []);
    const list = recent.get(entry.source);
    list.push({ seq: entry.seq, urgent: Boolean(entry.urgent) });
    if (list.length > 10000) list.splice(0, list.length - 10000);
  });
  // Filled in below, once the tasks exist: who wrote an entry.
  let describe = (entry) => entry;
  const logServer = await createLogServer({
    store,
    socketPath: logSocket,
    describe: (entry) => describe(entry),
  });
  const logEnv = {
    MF_LOG_SOCKET: logSocket,
    MF_LOG_DIR: resolve(logDir),
    MF_TOOLKIT_ROOT: toolkitRoot,
  };

  // Until when a host exit is the expected result of stopping one of its
  // programs, per character.
  const cancelling = new Map();
  // Characters whose process the liveness check killed (already reported).
  const killedUnresponsive = new Set();
  let hosts;
  try {
    hosts = await startBotHosts({
      env: { ...env, ...logEnv },
      ...(names ? { names } : {}),
      runDir: join(stateDir, "bots"),
      log,
      onExit(host, { code, signal }) {
        // A program that ignores cancellation gets its host killed (SIGKILL by
        // run.mjs, or exit 75 from the host itself); any other exit is a
        // crash that the model has to hear about.
        if (killedUnresponsive.delete(host.name)) return;
        const expected =
          (signal === "SIGKILL" || code === 75) &&
          Date.now() < (cancelling.get(host.name) ?? 0);
        store.append({
          source: "runtime",
          type: expected ? "host.restarted" : "host.crashed",
          bot: host.name,
          urgent: !expected,
          data: {
            exit: signal ?? code,
            ...(expected ? {} : { stop: "host crashed" }),
          },
        });
      },
    });
  } catch (error) {
    await logServer.close();
    throw error;
  }
  const sockets = new Map(hosts.bots.map((bot) => [bot.name, bot.runSocket]));
  const mainBot = hosts.bots[0].name;
  const taskDir = join(stateDir, "tasks");
  const tasks = new TaskManager({
    onUnwatchedEnd: (task, { delivered }) => {
      // The log is where an unwatched end is read.
      delivered("log");
      if (task.quiet) return;
      const tail = (buffer) => {
        const text = buffer.toString("utf8");
        return text.length > 600 ? `…${text.slice(-600)}` : text;
      };
      const stopped = (task.exitCode === 130 || task.signal) && task.interruptReason;
      store.append({
        source: "tasks",
        type: "ended",
        bot: taskBots.get(task.id),
        task: task.id,
        label: task.label,
        data: {
          ...(stopped ? { interrupted: task.interruptReason } : {}),
          ...(task.exitCode !== null ? { exitCode: task.exitCode } : {}),
          ...(task.signal ? { signal: task.signal } : {}),
          seconds: Math.round((task.completedAt - task.startedAt) / 100) / 10,
          ...(task.stdout.length ? { stdout: tail(task.stdout) } : {}),
          ...(task.stderr.length ? { stderr: tail(task.stderr) } : {}),
          ...(task.logDir ? { logDir: task.logDir } : {}),
        },
      });
    },
    cwd,
    env: { ...logEnv, ...hosts.env, MF_TASK_DIR: taskDir },
    logDir: taskDir,
    killGraceMs,
  });
  // The character each task runs on.
  const taskBots = new Map();
  describe = ({ source, type, key, urgent, bot, task, data }) => ({
    source: source ?? "program",
    type,
    key,
    urgent,
    bot: bot ?? taskBots.get(task),
    task,
    label: tasks.tasks.get(task)?.label,
    data,
  });

  // Per character: its controlling program and idle, and the lock that
  // orders takeovers.
  const chars = new Map(
    hosts.bots.map((host) => [
      host.name,
      {
        name: host.name,
        host,
        controller: null,
        idle: null,
        lock: Promise.resolve(),
        starting: 0,
        idleTimer: undefined,
        idleCustomFailed: null,
        idleOff: !idleEnabled,
        // Stops not yet shown at the start of a run or as its result.
        pendingStops: [],
      },
    ]),
  );
  let closed = false;

  const charOf = (bot) => {
    const c = chars.get(bot ?? mainBot);
    if (!c) throw new Error(`Unknown character ${bot}; characters: ${[...chars.keys()].join(", ")}`);
    return c;
  };
  const socketOf = (bot) => charOf(bot).host.runSocket;
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
  const moduleCommand = (file, { args = [], bot, persistent, readOnly } = {}) =>
    [
      quote(process.execPath),
      quote(runScript),
      ...(persistent ? ["--persistent"] : []),
      ...(readOnly ? ["--read-only"] : []),
      ...(bot ? ["--bot", quote(bot)] : []),
      quote(file),
      ...args.map(quote),
    ].join(" ");
  // quiet: a routine run (idle, snapshot) whose end is not logged.
  function startTask(file, { bot, args, persistent, readOnly, quiet, ...options }) {
    const id = tasks.start(moduleCommand(file, { args, bot, persistent, readOnly }), options);
    taskBots.set(id, bot ?? mainBot);
    if (quiet) tasks.tasks.get(id).quiet = true;
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
  /** Run fn while holding the character's takeover lock. */
  async function withLock(c, fn) {
    const previous = c.lock;
    let release;
    c.lock = new Promise((done) => (release = done));
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /** The characters an entry is about; none known means all of them. */
  function charactersOf(entry) {
    const name = entry.bot ?? taskBots.get(entry.task);
    return chars.has(name) ? [chars.get(name)] : [...chars.values()];
  }
  store.on("entry", (entry) => {
    const reason = stopReason(entry);
    if (!reason) return;
    for (const c of charactersOf(entry)) {
      c.pendingStops.push(entry);
      const task = c.controller && tasks.tasks.get(c.controller);
      if (task?.status === "running" && !task.interruptReason) {
        task.interruptReason = reason;
        task.interruptStop = entry;
        cancelTask(c.controller);
      }
    }
  });

  function cancelTask(id) {
    const bot = taskBots.get(id) ?? mainBot;
    cancelling.set(bot, Date.now() + killGraceMs + 5000);
    try {
      tasks.cancel(id);
    } catch {}
  }

  /** Stop the character's controlling program and idle; call with its lock held. */
  async function takeOver(c) {
    const ids = [];
    if (c.controller) {
      const task = tasks.tasks.get(c.controller);
      if (task?.status === "running") {
        task.interruptReason ??= "replaced by a new program";
        ids.push(c.controller);
      }
    }
    if (c.idle) {
      c.idle.cancelled = true;
      ids.push(c.idle.id);
    }
    for (const id of ids) cancelTask(id);
    await Promise.all(ids.map(completion));
  }

  const idleBlocked = (c) => closed || c.idleOff || c.controller || c.idle || c.starting;
  function scheduleIdle(c, delayMs = 0) {
    if (c.idleOff || closed) return;
    clearTimeout(c.idleTimer);
    c.idleTimer = setTimeout(() => void startIdle(c), delayMs);
  }
  async function startIdle(c) {
    if (idleBlocked(c)) return;
    let retry;
    await withLock(c, async () => {
      if (idleBlocked(c)) return;
      try {
        await hostReady(c.name);
      } catch (error) {
        log(`idle (${c.name}): ${error.message}`);
        retry = 5000;
        return;
      }
      if (idleBlocked(c)) return;
      // A workdir idle.mjs is loaded fresh each time; after it fails, the
      // built-in one runs until the file changes.
      const custom = join(cwd, "idle.mjs");
      let file = builtinIdle;
      if (existsSync(custom)) {
        const mtime = statSync(custom).mtimeMs;
        if (c.idleCustomFailed !== mtime) file = custom;
      }
      const id = startTask(file, {
        bot: chars.size > 1 ? c.name : undefined,
        cwd,
        label: `${file === builtinIdle ? "idle (built-in)" : "idle (idle.mjs)"}${chars.size > 1 ? ` (${c.name})` : ""}`,
        background: true,
        quiet: true,
      });
      const entry = { id, file, cancelled: false };
      c.idle = entry;
      const task = tasks.tasks.get(id);
      task.child.once("close", (code) => {
        if (c.idle === entry) c.idle = null;
        // Idle ending is routine; only a failure (below) is worth an entry.
        task.delivered = true;
        forget(id);
        if (entry.cancelled || closed) return;
        if (code === 75) return scheduleIdle(c, 1000); // Host restarting.
        const stderr = task.stderr.toString("utf8").slice(-600);
        store.append({
          source: "runtime",
          type: "idle.failed",
          bot: c.name,
          data: {
            file,
            exitCode: code,
            stderr,
            ...(file === builtinIdle ? {} : { fallback: "built-in idle" }),
          },
        });
        if (file !== builtinIdle) {
          c.idleCustomFailed = statSync(file, { throwIfNoEntry: false })?.mtimeMs ?? null;
          scheduleIdle(c, 0);
        } else scheduleIdle(c, 5000);
      });
    });
    if (retry) scheduleIdle(c, retry);
  }

  /** Entries not read with `mf log` yet, for the line under every result. */
  function unread() {
    const cursor = readCursor(logDir);
    let entries = 0;
    let urgent = 0;
    for (const [source, list] of recent) {
      const after = cursor[source] ?? 0;
      for (let i = list.length - 1; i >= 0 && list[i].seq > after; i--) {
        entries++;
        if (list[i].urgent) urgent++;
      }
    }
    return { entries, urgent };
  }

  /**
   * Wait until the program ends, or the caller goes away, or an urgent log
   * entry arrives (then the result gives its reason and the program keeps
   * running; its end goes to the log). Its output went to the caller as it
   * was printed, so the result leaves it out.
   */
  async function waitTask(id, { signal }) {
    const early = new AbortController();
    let why;
    const urgent = (entry) => {
      // A stop ends the program itself: its result says so.
      if (stopReason(entry) || early.signal.aborted) return;
      why = `${entry.type ?? "urgent entry"} in ${entry.source}${entry.bot ? ` (${entry.bot})` : ""}`;
      early.abort();
    };
    store.on("urgent", urgent);
    let result;
    try {
      result = await tasks.wait(id, { signal: AbortSignal.any([signal, early.signal].filter(Boolean)) });
    } finally {
      store.off("urgent", urgent);
    }
    const { stdout: _, stderr: __, ...rest } = result;
    const task = tasks.tasks.get(id);
    if (result.status === "running" && early.signal.aborted && !signal?.aborted)
      return { ...rest, character: taskBots.get(id), reason: `returned early: ${why}; see \`mf log\`` };
    // Interrupted only if it ended because it was stopped, not on its own.
    const stopped = result.exitCode === 130 || result.signal;
    if (task?.interruptReason && result.status === "completed" && stopped) {
      // The result says it, so the next run need not say it again.
      const c = chars.get(taskBots.get(id));
      if (c && task.interruptStop && !signal?.aborted)
        c.pendingStops = c.pendingStops.filter((entry) => entry !== task.interruptStop);
      return { ...rest, status: "interrupted", reason: task.interruptReason };
    }
    return rest;
  }

  /** Send the task's output to the caller as it is printed. */
  function streamTask(id, stream) {
    const task = tasks.tasks.get(id);
    if (!stream || !task?.child) return;
    stream({ stream: "started", taskId: id, character: taskBots.get(id), ...(task.logDir ? { logDir: task.logDir } : {}) });
    for (const channel of ["stdout", "stderr"]) {
      const decoder = new StringDecoder("utf8");
      task.child[channel].on("data", (data) => {
        const text = decoder.write(data);
        if (text) stream({ stream: channel, text });
      });
    }
  }

  /** The stops not shown yet, as lines for the start of the next run. */
  function takeStops(c) {
    const lines = c.pendingStops.map(
      (entry) =>
        `[since your last run] stop: ${stopReason(entry)} (${entry.bot ?? c.name}, ${new Date(entry.at).toISOString().slice(11, 19)})${entry.data?.position ? ` at ${JSON.stringify(entry.data.position)}` : ""}`,
    );
    c.pendingStops = [];
    return lines;
  }

  /**
   * Whether a module controls the character: false when it exports
   * `control = false`. The character's process imports it to see, and keeps
   * the imported module for the run that follows.
   */
  async function controls(file, request) {
    try {
      const answer = await hostRequest(socketOf(request.bot), { type: "probe", file });
      return answer.control !== false;
    } catch {
      return true; // It fails to load: the run says why.
    }
  }

  async function run(request, signal, stream) {
    if (typeof request.file !== "string" || !request.file)
      throw new Error("run needs a module file");
    const c = charOf(request.bot); // An unknown character fails before anything stops.
    const cwdOf = request.cwd || cwd;
    const file = isAbsolute(request.file) ? request.file : resolve(cwdOf, request.file);
    if (!existsSync(file)) throw new Error(`No such module: ${file}`);
    // A module that declares itself read-only runs beside the controller.
    // A kept module is read-only too, and restarts with its character.
    await hostReady(request.bot);
    const readOnly =
      request.readOnly === true ||
      request.keep === true ||
      !(await controls(file, request));
    const start = () =>
      startTask(file, {
        args: request.args ?? [],
        bot: request.bot,
        cwd: cwdOf,
        label: basename(file),
        background: readOnly,
        persistent: request.keep === true,
        readOnly,
      });
    if (readOnly) {
      const id = start();
      // A kept module never ends by design: say it started and return.
      if (request.keep)
        return { status: "started", taskId: id, character: c.name, logDir: tasks.tasks.get(id).logDir };
      streamTask(id, stream);
      return waitTask(id, { signal });
    }
    c.starting++;
    let id;
    let refused;
    try {
      // The lock covers stopping the old program, waiting for the character
      // and starting the new one, so two submissions cannot both start.
      id = await withLock(c, async () => {
        await takeOver(c);
        await hostReady(request.bot);
        if (signal?.aborted)
          return void (refused = { status: "not_started", reason: "the caller disconnected" });
        const started = start();
        c.controller = started;
        return started;
      });
    } finally {
      c.starting--;
      if (!id) scheduleIdle(c, 0);
    }
    if (!id) return refused;
    tasks.tasks.get(id).child.once("close", () => {
      if (c.controller === id) {
        c.controller = null;
        scheduleIdle(c, 0);
      }
    });
    // Stops up to now (including one while the old program ended or the
    // host restarted) come first, then the program's output.
    for (const text of takeStops(c)) stream?.({ stream: "note", text });
    streamTask(id, stream);
    return waitTask(id, { signal });
  }

  async function snapshot(request) {
    await hostReady(request.bot);
    const id = startTask(snapshotScript, {
      args: request.args ?? [],
      bot: request.bot,
      cwd: request.cwd || cwd,
      label: "snapshot",
      background: true,
      quiet: true,
    });
    const result = await tasks.wait(id, { timeoutMs: 15000 });
    if (result.status !== "completed") cancelTask(id);
    await completion(id);
    const task = tasks.tasks.get(id);
    if (task) task.delivered = true;
    // A cut snapshot keeps its log directory, where the whole output is.
    if (!result.outputDroppedBytes) forget(id);
    return result;
  }

  function status() {
    const roleOf = (task) => {
      const c = chars.get(taskBots.get(task.id));
      if (task.id === c?.controller) return "controlling";
      if (task.id === c?.idle?.id) return "idle";
      return "background";
    };
    const running = [...tasks.tasks.values()]
      .filter((task) => task.status === "running")
      .map((task) => ({
        taskId: task.id,
        label: task.label ?? task.command.slice(0, 80),
        character: taskBots.get(task.id),
        role: roleOf(task),
        startedAt: task.startedAt,
        ...(task.logDir ? { logDir: task.logDir } : {}),
      }));
    return {
      status: "status",
      sessionId,
      characters: hosts.bots.map(({ name, pid }) => ({
        name,
        running: Boolean(pid),
        idle: !chars.get(name).idleOff,
      })),
      tasks: running,
      log: logDir,
    };
  }

  // Liveness and lifecycle: one watch connection per character's process.
  // A process that sends no heartbeat for unresponsiveMs is blocked (a
  // synchronous loop, say): it is killed so the launcher restarts it.
  const LIFECYCLE = {
    death: { type: "character.died", stop: "death" },
    dimension: { type: "character.dimension", stop: "dimension changed" },
    session: { type: "character.session", stop: "session changed" },
    disconnected: { type: "character.disconnected", stop: "disconnected" },
  };
  const watches = new Map();
  function watchHost(c) {
    const generation = c.host.generation;
    if (closed || !generation || watches.get(c.name)?.generation === generation) return;
    watches.get(c.name)?.socket.destroy();
    const watch = { generation, lastBeat: Date.now(), socket: net.connect(c.host.runSocket) };
    watches.set(c.name, watch);
    let buffer = "";
    watch.socket.setEncoding("utf8");
    watch.socket.on("error", () => {});
    watch.socket.on("connect", () => watch.socket.write(`${JSON.stringify({ type: "watch" })}\n`));
    watch.socket.on("close", () => {
      if (watches.get(c.name) === watch) watches.delete(c.name);
    });
    watch.socket.on("data", (chunk) => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        watch.lastBeat = Date.now();
        if (message.type !== "lifecycle" || !LIFECYCLE[message.event]) continue;
        const { type: _, event, at: __, ...detail } = message;
        try {
          const { type, stop } = LIFECYCLE[event];
          store.append({
            source: "runtime",
            type,
            bot: c.name,
            urgent: true,
            data: { stop, ...detail },
          });
        } catch (error) {
          log(`lifecycle report failed: ${error.message}`);
        }
      }
    });
  }
  const liveness = setInterval(() => {
    for (const c of chars.values()) {
      const watch = watches.get(c.name);
      if (!watch || watch.generation !== c.host.generation) {
        // A new process: watch it once it answers.
        if (c.host.generation)
          void hostStatus(c.host.runSocket, { timeoutMs: 2000 }).then(
            () => watchHost(c),
            () => {},
          );
        continue;
      }
      if (unresponsiveMs > 0 && Date.now() - watch.lastBeat > unresponsiveMs && c.host.pid) {
        const pid = c.host.pid;
        killedUnresponsive.add(c.name);
        watch.socket.destroy();
        watches.delete(c.name);
        store.append({
          source: "runtime",
          type: "host.unresponsive",
          bot: c.name,
          urgent: true,
          data: {
            seconds: Math.round((Date.now() - watch.lastBeat) / 1000),
            action: "restarting the character's process",
            stop: "character process unresponsive",
          },
        });
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
      }
    }
  }, 1000);
  liveness.unref?.();

  /** Answer one request: { response }. */
  async function handle(request, signal, stream) {
    const answer = await answerRequest(request, signal, stream);
    // Every result says how much of the log is unread.
    if (request.type !== "shutdown" && answer.response?.status !== "error")
      answer.response = { ...answer.response, unread: unread() };
    return answer;
  }
  async function answerRequest(request, signal, stream) {
    switch (request.type) {
      case "run": {
        return { response: await run(request, signal, stream) };
      }
      case "cancel": {
        if (typeof request.taskId !== "string") throw new Error("cancel needs a taskId");
        const task = tasks.get(request.taskId);
        const c = chars.get(taskBots.get(request.taskId));
        // Cancelling idle turns it off for that character (`mf idle on` again).
        if (c?.idle?.id === request.taskId) {
          c.idleOff = true;
          c.idle.cancelled = true;
        }
        if (task.status === "running") {
          if (request.taskId === c?.controller) task.interruptReason ??= "cancelled";
          cancelTask(request.taskId);
          await completion(request.taskId);
        }
        return {
          response: {
            status: task.interruptReason ? "interrupted" : "completed",
            ...(task.interruptReason ? { reason: task.interruptReason } : {}),
            taskId: task.id,
            label: task.label,
            exitCode: task.exitCode,
            signal: task.signal,
            startedAt: task.startedAt,
            completedAt: task.completedAt,
            ...(task.logDir ? { logDir: task.logDir } : {}),
          },
        };
      }
      case "idle": {
        const targets = request.bot ? [charOf(request.bot)] : [...chars.values()];
        for (const c of targets) {
          c.idleOff = request.on === false;
          if (c.idleOff && c.idle) {
            c.idle.cancelled = true;
            cancelTask(c.idle.id);
          } else if (!c.idleOff) scheduleIdle(c, 0);
        }
        return {
          response: {
            status: "idle",
            characters: targets.map((c) => ({ name: c.name, idle: !c.idleOff })),
          },
        };
      }
      case "status":
        return { response: status() };
      case "snapshot":
        return { response: await snapshot(request) };
      case "shutdown":
        setImmediate(() => void close());
        return { response: { status: "stopping", pid: process.pid } };
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
      const stream = (message) => {
        if (!client.destroyed) client.write(`${JSON.stringify(message)}\n`);
      };
      handle(request, detached.signal, stream).then(
        ({ response }) => {
          // A caller that has gone gets nothing.
          if (client.destroyed || detached.signal.aborted) return;
          client.end(`${JSON.stringify(response)}\n`);
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
    clearInterval(liveness);
    for (const watch of watches.values()) watch.socket.destroy();
    for (const c of chars.values()) clearTimeout(c.idleTimer);
    // Callers still waiting on a result are cut off rather than waited for.
    for (const client of clients) client.destroy();
    if (control.listening) await new Promise((done) => control.close(() => done()));
    await rm(controlSocket, { force: true });
    // The characters stop their own programs as they quit; the tasks that ran
    // them then end on their own.
    hosts.close();
    await tasks.close();
    await logServer.close();
    markClosed();
  }

  let defaults;
  try {
    await prepareTaskDir(taskDir);
    await hostReady();
    // Every character gets the default scripts, its own idle and its own
    // controlling program (see runtime/README.md).
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
  for (const c of chars.values()) scheduleIdle(c, 0);

  // Resolves once the supervisor has shut down (after close() or `mf stop`).
  return { controlSocket, store, logDir, tasks, defaults, hosts, chars, close, closed: whenClosed, handle };
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
