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
 * needs the model's attention); the result carries the reports queued since
 * the last result, up to a size budget. See runtime/README.md.
 *
 * Each character has its own controlling program, idle behaviour, takeover
 * lock and list of changes the caller has not been given yet. Those changes
 * (death, a new dimension, a session change, a crashed or blocked process)
 * come from the character's process over an internal channel, not from
 * reports, so they hold with every default script turned off. A program for
 * a character with undelivered changes is not started.
 *
 * Delivery is a two-step exchange: the result is written, and its reports
 * and changes count as given only after the caller confirms it read the
 * result. A caller that disconnects first leaves them queued for the next
 * result: they may repeat, but are not lost.
 */
import { existsSync, statSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { basename, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Inbox, createInboxServer } from "./inbox/index.mjs";
import { TaskManager } from "./tasks/index.mjs";
import { startBotHosts } from "./host/launcher.mjs";
import { StringDecoder } from "node:string_decoder";
import { status as hostStatus } from "./host/rpc.mjs";
import { socketPath } from "./socket-path.mjs";

const here = (path) => fileURLToPath(new URL(path, import.meta.url));
const runScript = here("./host/run.mjs");
const builtinIdle = here("./default-scripts/idle.mjs");
const snapshotScript = here("./default-scripts/snapshot.mjs");
const defaultScriptFiles = {
  observer: here("./default-scripts/observer.mjs"),
  chat: here("./default-scripts/chat.mjs"),
  watchdog: here("./default-scripts/watchdog.mjs"),
};
// Programs import the toolkit from here: `${process.env.MF_TOOLKIT_ROOT}/runtime/...`.
const toolkitRoot = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");

/**
 * Reports that make the model's current plan stale: the character's program
 * is stopped and the next one waits until the caller has seen the change.
 * The runtime posts its own (source "runtime"); a program or an adapter (an
 * arena's match rules, say) marks one with `major: "reason"` in its data.
 */
const RUNTIME_MAJOR = {
  "character.died": "death",
  "character.dimension": "dimension changed",
  "character.session": "session changed",
  "character.disconnected": "disconnected",
  "host.crashed": "host crashed",
  "host.unresponsive": "character process unresponsive",
};
export function majorReason(message) {
  const data = message?.data;
  if (!data || typeof data !== "object") return null;
  if (message.source === "runtime" && RUNTIME_MAJOR[data.type])
    return RUNTIME_MAJOR[data.type];
  if (message.kind === "judgment" && data.type === "blocked") return "blocked";
  if (typeof data.major === "string" && data.major) return data.major.slice(0, 120);
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
  // Longer than run.mjs's grace for a stuck module (it then stops the host),
  // so a replaced program has really let go of the bot before the next starts.
  killGraceMs = 5000,
  // How much report text one result carries (MF_REPORT_BYTES); the rest waits.
  reportBytes = Number(env.MF_REPORT_BYTES ?? 16000),
  // A character's process that sends no heartbeat for this long is killed
  // and restarted (MF_HOST_UNRESPONSIVE_SECONDS; 0 turns it off).
  unresponsiveMs = Number(env.MF_HOST_UNRESPONSIVE_SECONDS ?? 20) * 1000,
  log = (line) => process.stderr.write(`${line}\n`),
} = {}) {
  for (const name of defaultScripts)
    if (!defaultScriptFiles[name])
      throw new Error(`Unknown default script: ${name}`);
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const gitignore = join(stateDir, ".gitignore");
  if (!existsSync(gitignore)) await writeFile(gitignore, "*\n");
  const sessionId = env.MC_INBOX_SESSION || `mf-${Date.now()}`;
  const inboxSocket = socketPath(resolve(stateDir), "inbox.sock");
  const controlSocket = socketPath(resolve(stateDir), "control.sock");
  await claimSocket(controlSocket);
  await claimSocket(inboxSocket);
  // Reports wait until the model receives them; only the size limit (or a
  // ttlMs a program sets on its own message) drops them.
  const inbox = new Inbox({ sessionId, ttlMs: Infinity });
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
  // Characters whose process the liveness check killed (already reported).
  const killedUnresponsive = new Set();
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
        if (killedUnresponsive.delete(host.name)) return;
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

  // Per character: its controlling program and idle, the lock that orders
  // takeovers, and the changes the caller has not been given yet.
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
        changes: [],
        seq: 0,
        idleTimer: undefined,
        idleCustomFailed: null,
        idleOff: !idleEnabled,
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

  /** The characters a message is about; none known means all of them. */
  function charactersOf(message) {
    const name = message.data?.bot ?? message.bot ?? taskBots.get(message.taskId);
    return chars.has(name) ? [chars.get(name)] : [...chars.values()];
  }
  inbox.on("message", (message) => {
    const reason = majorReason(message);
    if (!reason) return;
    for (const c of charactersOf(message)) {
      c.changes.push({ seq: ++c.seq, character: c.name, reason, at: message.createdAt });
      const task = c.controller && tasks.tasks.get(c.controller);
      if (task?.status === "running" && !task.interruptReason) {
        task.interruptReason = reason;
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
      });
      const entry = { id, file, cancelled: false };
      c.idle = entry;
      const task = tasks.tasks.get(id);
      task.child.once("close", (code) => {
        if (c.idle === entry) c.idle = null;
        // Idle ending is routine; only a failure (below) is worth a report.
        if (task.eventId) inbox.remove(task.eventId);
        task.delivered = true;
        forget(id);
        if (entry.cancelled || closed) return;
        if (code === 75) return scheduleIdle(c, 1000); // Host restarting.
        const stderr = task.stderr.toString("utf8").slice(-600);
        inbox.post(
          {
            sessionId,
            kind: "event",
            data: {
              type: "idle.failed",
              bot: c.name,
              file,
              exitCode: code,
              stderr,
              ...(file === builtinIdle ? {} : { fallback: "built-in idle" }),
            },
          },
          { source: "runtime" },
        );
        if (file !== builtinIdle) {
          c.idleCustomFailed = statSync(file, { throwIfNoEntry: false })?.mtimeMs ?? null;
          scheduleIdle(c, 0);
        } else scheduleIdle(c, 5000);
      });
    });
    if (retry) scheduleIdle(c, retry);
  }

  /**
   * The result plus what it can carry: every undelivered change and as many
   * reports as fit in the budget. `commit` marks exactly those reports as
   * given, and clears the changes it showed. `mf run` uses it only when the
   * caller waits in the foreground and asks for it (`--inbox`); otherwise a
   * background program's end would mark reports given while they sit unread
   * in the job's output. A refused start shows the changes (reports: false).
   */
  function deliver(result, { reports = true } = {}) {
    const batch = reports
      ? inbox.select({ maxBytes: reportBytes })
      : { ids: [], messages: [], remaining: 0, dropped: { overflow: 0, expired: 0 } };
    const changes = [...chars.values()].flatMap((c) => c.changes);
    const upTo = new Map([...chars.values()].map((c) => [c, c.seq]));
    const generationOf = (bot) => chars.get(bot)?.host.generation;
    const response = {
      ...result,
      ...(changes.length ? { changes: changes.map(({ seq: _, ...change }) => change) } : {}),
      reports: batch.messages.map(
        ({ id, sessionId: _, expiresAt, eligibleAt, generation, ...message }) => {
          const label = message.taskId && tasks.tasks.get(message.taskId)?.label;
          // A program that ended unwatched says why it was stopped.
          const stopped =
            message.data?.type === "task.completed" &&
            tasks.tasks.get(message.data.taskId)?.interruptReason;
          // An unwatched program's end carries only the end of its output.
          if (message.data?.type === "task.completed")
            for (const channel of ["stdout", "stderr"])
              if (typeof message.data[channel] === "string" && message.data[channel].length > 2000)
                message.data = { ...message.data, [channel]: `…${message.data[channel].slice(-2000)}` };
          return {
            ...message,
            ...(label ? { from: label } : {}),
            // Seen by a process of the character that has since restarted.
            ...(generation && message.bot && generation !== generationOf(message.bot)
              ? { earlierProcess: true }
              : {}),
            ...(stopped ? { data: { ...message.data, interrupted: stopped } } : {}),
          };
        },
      ),
      ...(batch.remaining ? { moreReports: batch.remaining } : {}),
      ...(batch.dropped.overflow || batch.dropped.expired
        ? { droppedReports: batch.dropped }
        : {}),
    };
    const commit = () => {
      inbox.commit(batch);
      // Only the changes this result showed; later ones still block starts.
      for (const [c, seq] of upTo) c.changes = c.changes.filter((change) => change.seq > seq);
      tasks.resumeWaits();
    };
    return { response, commit };
  }

  /**
   * Wait until the program ends (or the caller goes away: the program keeps
   * running and its end is reported in the inbox). Its output went to the
   * caller as it was printed, so the result leaves it out.
   */
  async function waitTask(id, { signal }) {
    const result = await tasks.wait(id, { signal, urgent: false });
    const { stdout: _, stderr: __, ...rest } = result;
    const task = tasks.tasks.get(id);
    return task?.interruptReason && result.status === "completed"
      ? { ...rest, status: "interrupted", reason: task.interruptReason }
      : rest;
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

  const notStarted = (c) => ({
    status: "not_started",
    character: c.name,
    reason: `${[...new Set(c.changes.map((change) => change.reason))].join(", ")} since your last result; the program was not started`,
  });

  async function run(request, signal, stream) {
    if (typeof request.file !== "string" || !request.file)
      throw new Error("run needs a module file");
    const c = charOf(request.bot); // An unknown character fails before anything stops.
    const cwdOf = request.cwd || cwd;
    const file = isAbsolute(request.file) ? request.file : resolve(cwdOf, request.file);
    if (!existsSync(file)) throw new Error(`No such module: ${file}`);
    // A module that declares itself read-only runs beside the controller.
    // A kept module is read-only too, and restarts with its character.
    const readOnly =
      request.readOnly === true ||
      request.keep === true ||
      /^export\s+const\s+control\s*=\s*false\b/m.test(await readFile(file, "utf8"));
    const start = () =>
      startTask(file, {
        args: request.args ?? [],
        bot: request.bot,
        cwd: cwdOf,
        label: basename(file),
        background: readOnly,
        persistent: request.keep === true,
      });
    if (readOnly) {
      await hostReady(request.bot);
      const id = start();
      // A kept module never ends by design: say it started and return.
      if (request.keep)
        return { status: "started", taskId: id, character: c.name, logDir: tasks.tasks.get(id).logDir };
      streamTask(id, stream);
      return waitTask(id, { signal });
    }
    if (c.changes.length) return notStarted(c);
    c.starting++;
    let id;
    let refused;
    try {
      // The lock covers stopping the old program, waiting for the character
      // and starting the new one, so two submissions cannot both start.
      id = await withLock(c, async () => {
        await takeOver(c);
        await hostReady(request.bot);
        // A change while the old program stopped or the host restarted.
        if (c.changes.length) return void (refused = notStarted(c));
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
        ...(chars.get(name).changes.length
          ? { undeliveredChanges: chars.get(name).changes.map((change) => change.reason) }
          : {}),
      })),
      tasks: running,
      // What programs set with InboxClient.setStatus.
      programStatus: inbox.currentSnapshot(),
      pendingReports: inbox.items.length,
    };
  }

  // Liveness and lifecycle: one watch connection per character's process.
  // A process that sends no heartbeat for unresponsiveMs is blocked (a
  // synchronous loop, say): it is killed so the launcher restarts it.
  const LIFECYCLE = {
    death: "character.died",
    dimension: "character.dimension",
    session: "character.session",
    disconnected: "character.disconnected",
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
          inbox.post(
            {
              sessionId,
              kind: "event",
              priority: "urgent",
              data: { type: LIFECYCLE[event], bot: c.name, ...detail },
            },
            { source: "runtime" },
          );
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
        inbox.post(
          {
            sessionId,
            kind: "event",
            priority: "urgent",
            data: {
              type: "host.unresponsive",
              bot: c.name,
              seconds: Math.round((Date.now() - watch.lastBeat) / 1000),
              action: "restarting the character's process",
            },
          },
          { source: "runtime" },
        );
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
      }
    }
  }, 1000);
  liveness.unref?.();

  /**
   * Answer one request: { response, commit? }. commit, when present, is
   * called only after the caller confirmed it read the response.
   */
  async function handle(request, signal, stream) {
    switch (request.type) {
      case "run": {
        const result = await run(request, signal, stream);
        if (request.inbox) return deliver(result);
        if (result.status === "not_started") return deliver(result, { reports: false });
        return { response: result };
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
        return deliver({
          status: task.interruptReason ? "interrupted" : "completed",
          ...(task.interruptReason ? { reason: task.interruptReason } : {}),
          taskId: task.id,
          label: task.label,
          exitCode: task.exitCode,
          signal: task.signal,
          startedAt: task.startedAt,
          completedAt: task.completedAt,
          ...(task.logDir ? { logDir: task.logDir } : {}),
        });
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
      case "inbox":
        return deliver({ status: "inbox" });
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
        ({ response, commit }) => {
          // A caller that has gone gets nothing, and nothing counts as given.
          if (client.destroyed || detached.signal.aborted) return;
          if (!commit) return client.end(`${JSON.stringify(response)}\n`);
          client.write(`${JSON.stringify(response)}\n`);
          // The caller answers "ack" once it has read the result.
          let acked = "";
          const timer = setTimeout(() => client.destroy(), 10000);
          client.on("data", (more) => {
            acked += more;
            if (!acked.includes("\n")) return;
            clearTimeout(timer);
            if (acked.trim() === "ack") commit();
            client.end();
          });
          client.once("close", () => clearTimeout(timer));
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
    await inboxServer.close();
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
  return { controlSocket, inbox, tasks, defaults, hosts, chars, close, closed: whenClosed, handle };
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
