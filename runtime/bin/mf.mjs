#!/usr/bin/env node
/**
 * mf: drive Mineflayer characters from a shell.
 *
 *   mf start                     start the supervisor and the character(s)
 *   mf stop                      stop them
 *   mf run [options] FILE [ARGS] run a module until it ends: its output
 *                                appears as it is printed, then how it ended
 *   mf inbox                     the reports queued since your last result
 *   mf status                    characters, programs, idle
 *   mf cancel TASK_ID            stop a program (ending `mf run` does not)
 *   mf idle on|off [--bot NAME]  turn the behaviour between programs on or off
 *   mf snapshot [--full-entities] [--full-local] [--full-items]
 *
 * Options for run:
 *   --bot NAME      which character (default: the first)
 *   --inbox         when you wait in the foreground: add `mf inbox` at the end
 *   --read-only     a helper that does not replace the controlling program
 *                   (same as `export const control = false` in the module)
 *   --keep          a read-only helper that keeps running and restarts with
 *                   its character; mf returns once it has started
 *
 * `mf run` waits until the program ends. To do other things meanwhile, run it
 * in your tool's background shell and read `mf inbox` in the foreground.
 *
 * State lives in MF_STATE_DIR (default ./.mf, so run mf from the directory
 * where you started it). `mf start` needs MF_USERNAME (or MF_USERNAMES) and
 * MF_HOST.
 */
import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import net from "node:net";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { socketPath } from "../socket-path.mjs";

const stateDir = resolve(process.env.MF_STATE_DIR || join(process.cwd(), ".mf"));
const controlSocket = socketPath(stateDir, "control.sock");
const supervisorScript = fileURLToPath(new URL("../supervisor.mjs", import.meta.url));

/**
 * Send one request and resolve with its result. Results that carry reports
 * wait for `ack()`: call it once the result is printed, and only then do the
 * reports count as given (without it they come again next time).
 */
let pendingAck = () => {};
function request(message, onStream = () => {}) {
  return new Promise((done, fail) => {
    const socket = net.connect(controlSocket);
    let buffer = "";
    let settled = false;
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(`${JSON.stringify(message)}\n`));
    socket.on("data", (chunk) => {
      if (settled) return;
      buffer += chunk;
      let end;
      while (!settled && (end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          settled = true;
          socket.destroy();
          return fail(new Error("Unreadable result from the supervisor"));
        }
        // Output and progress while the program runs; the result comes last.
        if (message.stream) {
          onStream(message);
          continue;
        }
        settled = true;
        pendingAck = () => {
          if (!socket.destroyed) socket.end("ack\n");
        };
        done(message);
      }
    });
    socket.on("error", (error) => {
      if (settled) return;
      settled = true;
      fail(
        error.code === "ENOENT" || error.code === "ECONNREFUSED"
          ? Object.assign(new Error(`No supervisor in ${stateDir}; run \`mf start\` first`), { code: error.code })
          : error,
      );
    });
    socket.once("close", () => {
      if (settled) return;
      settled = true;
      fail(new Error("No result: the supervisor stopped or dropped the connection"));
    });
  });
}

function parse(argv) {
  const options = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (rest.length) rest.push(arg);
    else if (arg === "--bot") {
      options.bot = argv[++i];
      if (!options.bot) throw new Error("--bot needs a character name");
    }
    else if (arg === "--read-only") options.readOnly = true;
    else if (arg === "--keep") options.keep = true;
    else if (arg === "--inbox") options.inbox = true;
    else rest.push(arg);
  }
  return { options, rest };
}

const seconds = (ms) => `${(ms / 1000).toFixed(1)}s`;

function header(result) {
  const parts = [result.status];
  if (result.reason) parts.push(result.reason);
  if (result.status === "completed" || result.status === "interrupted") {
    if (result.exitCode !== undefined && result.exitCode !== null)
      parts.push(`exit ${result.exitCode}`);
    else if (result.signal) parts.push(result.signal);
  }
  const end = result.completedAt ?? Date.now();
  if (result.startedAt) parts.push(`after ${seconds(end - result.startedAt)}`);
  const ids = [
    result.taskId ? `task=${result.taskId}` : null,
    result.logDir ? `logs=${result.logDir}` : null,
  ].filter(Boolean);
  return `[${parts.join(", ")}]${ids.length ? ` ${ids.join(" ")}` : ""}`;
}

function report(message) {
  const { priority, kind, key, taskId, source, createdAt, data, from: origin, bot, earlierProcess } = message;
  const mark = priority === "urgent" ? "!" : "-";
  const label = data?.type ?? key ?? kind;
  const { type, ...rest } = data && typeof data === "object" ? data : { value: data };
  const from = source === "runtime" ? "runtime" : (origin ?? taskId ?? source);
  const about = [from, bot && !origin?.includes(bot) ? bot : null, new Date(createdAt).toISOString().slice(11, 19)]
    .filter(Boolean)
    .join(", ");
  return `${mark} ${label} (${about}${earlierProcess ? ", before a restart" : ""}) ${JSON.stringify(rest)}`;
}

/** The end of `text`, at most `limit` bytes, and how many bytes were left out. */
function tail(text, limit) {
  const bytes = Buffer.from(text ?? "", "utf8");
  if (bytes.length <= limit) return { text: text ?? "", omitted: 0 };
  let start = bytes.length - limit;
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
  return { text: bytes.subarray(start).toString("utf8"), omitted: start };
}

function print(result) {
  if (result.status === "error") {
    process.stderr.write(`mf: ${result.error}\n`);
    process.exitCode = 1;
    return;
  }
  if (result.status === "status" || result.status === "idle") {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  const out = [];
  if (result.status !== "inbox") out.push(header(result));
  for (const change of result.changes ?? [])
    out.push(`! changed: ${change.reason} (${change.character}, ${new Date(change.at).toISOString().slice(11, 19)})`);
  const reports = result.reports ?? [];
  if (reports.length) {
    out.push(`--- reports (${reports.length}) ---`);
    for (const message of reports) out.push(report(message));
  } else if (result.status === "inbox" && !result.changes?.length) out.push("no new reports");
  if (result.moreReports)
    out.push(`(${result.moreReports} more reports queued; \`mf inbox\` shows them)`);
  const dropped = result.droppedReports;
  if (dropped?.overflow) out.push(`(${dropped.overflow} older reports dropped: queue full)`);
  if (dropped?.expired) out.push(`(${dropped.expired} reports expired before they were shown)`);
  process.stdout.write(`${out.join("\n")}\n`);
  // The exit code follows the program: 0 when it finished, 1 when it threw,
  // 130 when it was interrupted, 75 when it was not started.
  if (result.status === "completed" && result.exitCode) process.exitCode = 1;
  if (result.status === "interrupted") process.exitCode = 130;
  if (result.status === "not_started") process.exitCode = 75;
}

/** Program output as it arrives: stdout to stdout, stderr to stderr. */
function streamed(message) {
  if (message.stream === "started")
    process.stdout.write(
      `[started] task=${message.taskId}${message.character ? ` character=${message.character}` : ""}${message.logDir ? ` logs=${message.logDir}` : ""}\n`,
    );
  else if (message.stream === "stdout") process.stdout.write(message.text);
  else if (message.stream === "stderr") process.stderr.write(message.text);
}

async function start() {
  try {
    await request({ type: "status" });
    process.stdout.write("Already running\n");
    return;
  } catch {}
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const logFile = join(stateDir, "supervisor.log");
  const out = openSync(logFile, "a");
  const child = spawn(process.execPath, [supervisorScript], {
    cwd: process.cwd(),
    env: { ...process.env, MF_STATE_DIR: stateDir },
    detached: true,
    stdio: ["ignore", out, out],
  });
  child.unref();
  const deadline = Date.now() + 90000;
  let exited = false;
  child.once("exit", () => (exited = true));
  while (Date.now() < deadline && !exited) {
    try {
      const result = await request({ type: "status" });
      process.stdout.write(
        `Started: ${result.characters.map((c) => c.name).join(", ")} (log: ${logFile})\n`,
      );
      return;
    } catch {
      await new Promise((done) => setTimeout(done, 500));
    }
  }
  // The character's own connection error says more than the timeout after it.
  const lines = (await readFile(logFile, "utf8").catch(() => "")).split("\n");
  const reason =
    lines.filter((line) => line.startsWith("Minecraft bot: ")).at(-1) ??
    lines.filter((line) => /Error\b/.test(line)).at(-1);
  throw new Error(`The supervisor did not start${reason ? `: ${reason.trim()}` : ""}; see ${logFile}`);
}

async function main() {
  const [command, ...argv] = process.argv.slice(2);
  const { options, rest } = parse(argv);
  switch (command) {
    case "start":
      return start();
    case "stop": {
      const result = await request({ type: "shutdown" });
      if (result.status === "error") return print(result);
      // Wait until it is gone, so that `mf start` right after cannot race it.
      for (let i = 0; i < 300 && result.pid; i++) {
        try {
          process.kill(result.pid, 0);
        } catch {
          break;
        }
        await new Promise((done) => setTimeout(done, 100));
      }
      process.stdout.write("Stopped\n");
      return;
    }
    case "run":
      if (!rest[0]) throw new Error("usage: mf run [options] FILE [ARGS...]");
      return print(
        await request({ type: "run", file: rest[0], args: rest.slice(1), cwd: process.cwd(), ...options }, streamed),
      );
    case "cancel":
      if (!rest[0]) throw new Error("usage: mf cancel TASK_ID");
      return print(await request({ type: "cancel", taskId: rest[0] }));
    case "inbox":
      return print(await request({ type: "inbox" }));
    case "idle":
    {
      // Options may also come after on|off here.
      const { options: more } = parse(rest.slice(1));
      if (rest[0] !== "on" && rest[0] !== "off") throw new Error("usage: mf idle on|off [--bot NAME]");
      return print(await request({ type: "idle", on: rest[0] === "on", ...options, ...more }));
    }
    case "status":
      return print(await request({ type: "status" }));
    case "snapshot": {
      const result = await request({ type: "snapshot", args: rest, cwd: process.cwd(), ...options });
      if (result.status === "error") return print(result);
      process.stdout.write(result.stdout || `${header(result)}\n${result.stderr ?? ""}\n`);
      if (result.outputDroppedBytes)
        process.stderr.write(
          `mf: the snapshot was cut (${result.outputDroppedBytes} bytes dropped); see ${result.logDir ?? "the logs"}\n`,
        );
      return;
    }
    default:
      process.stderr.write(
        "usage: mf start | stop | run [--bot NAME] [--inbox] [--read-only] [--keep] FILE [ARGS] | inbox | status | cancel TASK_ID | idle on|off | snapshot\n",
      );
      process.exitCode = 2;
  }
}

// A reader that stops early (| head) is not an error.
process.stdout.on("error", (error) => {
  if (error.code === "EPIPE") process.exit(0);
  throw error;
});

main().then(
  // Every result has been printed by now: confirm it, then let go.
  () => pendingAck(),
).catch((error) => {
  process.stderr.write(`mf: ${error.message}\n`);
  process.exitCode = 1;
});
