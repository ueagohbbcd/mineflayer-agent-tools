#!/usr/bin/env node
/**
 * mf: drive Mineflayer characters from a shell.
 *
 *   mf start                     start the supervisor and the character(s)
 *   mf stop                      stop them
 *   mf run [options] FILE [ARGS] run a module until it ends: its output
 *                                appears as it is printed, then how it ended.
 *                                An urgent log entry makes it return early,
 *                                with the reason; the program keeps running.
 *   mf log [options]             what the log got since you last read it,
 *                                source by source, summarized
 *   mf status                    characters, programs, idle
 *   mf cancel TASK_ID            stop a program (ending `mf run` does not)
 *   mf idle on|off [--bot NAME]  turn the behaviour between programs on or off
 *   mf snapshot [--full-entities] [--full-local] [--full-items]
 *
 * Options for run:
 *   --bot NAME      which character (default: the first)
 *   --read-only     a helper that does not replace the controlling program
 *                   (same as `export const control = false` in the module)
 *   --keep          a read-only helper that keeps running and restarts with
 *                   its character; mf returns once it has started
 *
 * Options for log:
 *   --source A,B    only these sources (runtime, tasks, chat, program, ...)
 *   --bot NAME      only this character (leaves the rest unread)
 *   --since 10m     everything from 10 minutes (or 90s, 1h) ago, read or not
 *   --all           everything kept, read or not
 *   --raw           entries as they are, without a source's summary
 *   --peek          show what is new without marking it read
 *
 * `mf run` waits until the program ends. To do other things meanwhile, run it
 * in your tool's background shell and read `mf log` in the foreground.
 *
 * State lives in MF_STATE_DIR (default ./.mf, so run mf from the directory
 * where you started it); the log is its log/ directory, one JSONL file per
 * source. `mf start` needs MF_USERNAME (or MF_USERNAMES) and MF_HOST.
 */
import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import net from "node:net";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { socketPath } from "../socket-path.mjs";
import { readLog } from "../log/view.mjs";
import { writeLogResult } from "../log/output.mjs";

const stateDir = resolve(process.env.MF_STATE_DIR || join(process.cwd(), ".mf"));
const controlSocket = socketPath(stateDir, "control.sock");
const supervisorScript = fileURLToPath(new URL("../supervisor.mjs", import.meta.url));

/** Send one request and resolve with its result. */
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
        socket.end();
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
    else if (arg === "--source") {
      options.sources = (argv[++i] ?? "").split(",").map((name) => name.trim()).filter(Boolean);
      if (!options.sources.length) throw new Error("--source needs a source name");
    } else if (arg === "--since") {
      const match = /^(\d+(?:\.\d+)?)(s|m|h)$/.exec(argv[++i] ?? "");
      if (!match) throw new Error("--since needs a duration such as 90s, 10m or 1h");
      options.since = Date.now() - Number(match[1]) * { s: 1000, m: 60000, h: 3600000 }[match[2]];
    } else if (arg === "--all") options.all = true;
    else if (arg === "--raw") options.raw = true;
    else if (arg === "--peek") options.peek = true;
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
  const out = [header(result)];
  if (result.status === "running")
    out.push(`(the program keeps running: \`mf cancel ${result.taskId}\` stops it; its end goes to the log, source tasks)`);
  if (unreadLine(result)) out.push(unreadLine(result));
  process.stdout.write(`${out.join("\n")}\n`);
  // The exit code follows the program: 0 when it finished, 1 when it threw,
  // 130 when it was interrupted, 75 when it was not started.
  if (result.status === "completed" && result.exitCode) process.exitCode = 1;
  if (result.status === "interrupted") process.exitCode = 130;
  if (result.status === "not_started") process.exitCode = 75;
}

/** The line under a result when the log has unread entries. */
function unreadLine(result) {
  const u = result.unread;
  if (!u?.entries) return "";
  return `(unread in \`mf log\`: ${u.entries} entr${u.entries === 1 ? "y" : "ies"}${u.urgent ? `, ${u.urgent} urgent` : ""})`;
}

/** Program output as it arrives: stdout to stdout, stderr to stderr. */
function streamed(message) {
  if (message.stream === "started")
    process.stdout.write(
      `[started] task=${message.taskId}${message.character ? ` character=${message.character}` : ""}${message.logDir ? ` logs=${message.logDir}` : ""}\n`,
    );
  else if (message.stream === "note") process.stdout.write(`${message.text}\n`);
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
    case "run": {
      if (!rest[0]) throw new Error("usage: mf run [options] FILE [ARGS...]");
      return print(
        await request(
          { type: "run", file: rest[0], args: rest.slice(1), cwd: process.cwd(), ...options },
          streamed,
        ),
      );
    }
    case "cancel":
      if (!rest[0]) throw new Error("usage: mf cancel TASK_ID");
      return print(await request({ type: "cancel", taskId: rest[0] }));
    case "log": {
      // Read straight from the files: it works with the supervisor stopped too.
      const result = await readLog({ dir: join(stateDir, "log"), ...options });
      await writeLogResult(result);
      return;
    }
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
      if (unreadLine(result)) process.stdout.write(`${unreadLine(result)}\n`);
      if (result.outputDroppedBytes)
        process.stderr.write(
          `mf: the snapshot was cut (${result.outputDroppedBytes} bytes dropped); see ${result.logDir ?? "the logs"}\n`,
        );
      return;
    }
    default:
      process.stderr.write(
        "usage: mf start | stop | run [--bot NAME] [--read-only] [--keep] FILE [ARGS] | log [--source A,B] [--bot NAME] [--since 10m | --all] [--raw] [--peek] | status | cancel TASK_ID | idle on|off | snapshot\n",
      );
      process.exitCode = 2;
  }
}

// A reader that stops early (| head) is not an error.
process.stdout.on("error", (error) => {
  if (error.code === "EPIPE") process.exit(0);
  throw error;
});

main().catch((error) => {
  process.stderr.write(`mf: ${error.message}\n`);
  process.exitCode = 1;
});
