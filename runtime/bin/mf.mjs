#!/usr/bin/env node
/**
 * mf: drive Mineflayer characters from a shell, one step at a time.
 *
 *   mf start                     start the supervisor and the character(s)
 *   mf stop                      stop them
 *   mf run [options] FILE [ARGS] run a module and wait for its result
 *   mf wait [options] TASK_ID    keep waiting on a program that is running
 *   mf cancel TASK_ID            stop a program
 *   mf events                    only the reports queued since the last result
 *   mf status                    characters and running programs
 *   mf snapshot [--full-entities] [--full-local] [--full-items]
 *
 * Options for run and wait:
 *   --wait S        return after S seconds while the program keeps running
 *                   (default 30; 0 returns at once)
 *   --stall S       return early when, for S seconds, the program printed
 *                   nothing and the character's position, health, food and
 *                   inventory did not change (default 20; 0 turns it off;
 *                   only used when it is shorter than --wait)
 *   --bot NAME      which character (default: the first)
 *   --background    a read-only helper: it does not replace the controlling
 *                   program and is never interrupted
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

// Output of the program shown in one result; the rest is in its logs.
const outputBytes = Number(process.env.MF_OUTPUT_BYTES ?? 8000);

/**
 * Send one request and resolve with its result. Results that carry reports
 * wait for `ack()`: call it once the result is printed, and only then do the
 * reports count as given (without it they come again next time).
 */
let pendingAck = () => {};
function request(message) {
  return new Promise((done, fail) => {
    const socket = net.connect(controlSocket);
    let buffer = "";
    let settled = false;
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(`${JSON.stringify(message)}\n`));
    socket.on("data", (chunk) => {
      if (settled) return;
      buffer += chunk;
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      settled = true;
      try {
        const result = JSON.parse(buffer.slice(0, end));
        pendingAck = () => {
          if (!socket.destroyed) socket.end("ack\n");
        };
        done(result);
      } catch {
        socket.destroy();
        fail(new Error("Unreadable result from the supervisor"));
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
    else if (arg === "--wait" || arg === "--stall") {
      const value = Number(argv[++i]);
      if (!Number.isFinite(value) || value < 0) throw new Error(`${arg} needs seconds`);
      options[arg.slice(2)] = value;
    } else if (arg === "--bot") {
      options.bot = argv[++i];
      if (!options.bot) throw new Error("--bot needs a character name");
    }
    else if (arg === "--background") options.background = true;
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
  if (result.status === "status") {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  // Most important first, so that a harness cutting the end loses the least:
  // the status, what changed, the program's output, then the other reports.
  const out = [];
  if (result.status !== "events") out.push(header(result));
  for (const change of result.changes ?? [])
    out.push(`! changed: ${change.reason} (${change.character}, ${new Date(change.at).toISOString().slice(11, 19)})`);
  const stdout = tail(result.stdout, outputBytes);
  const stderr = tail(result.stderr, Math.max(1000, outputBytes - Buffer.byteLength(stdout.text)));
  if (stdout.omitted || stderr.omitted || result.previouslyReturnedBytes)
    out.push(`(earlier output not shown; full output in ${result.logDir ?? "the logs"})`);
  if (stdout.text) out.push(stdout.text.replace(/\n$/, ""));
  if (stderr.text) out.push(`--- stderr ---`, stderr.text.replace(/\n$/, ""));
  const reports = result.reports ?? [];
  if (reports.length) {
    out.push(`--- reports (${reports.length}) ---`);
    for (const message of reports) out.push(report(message));
  } else if (result.status === "events") out.push("no new reports");
  if (result.moreReports)
    out.push(`(${result.moreReports} more reports queued; \`mf events\` shows them)`);
  const dropped = result.droppedReports;
  if (dropped?.overflow) out.push(`(${dropped.overflow} older reports dropped: queue full)`);
  if (dropped?.expired) out.push(`(${dropped.expired} reports expired before they were shown)`);
  process.stdout.write(`${out.join("\n")}\n`);
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
        await request({ type: "run", file: rest[0], args: rest.slice(1), cwd: process.cwd(), ...options }),
      );
    case "wait":
      if (!rest[0]) throw new Error("usage: mf wait [options] TASK_ID");
      return print(await request({ type: "wait", taskId: rest[0], ...options }));
    case "cancel":
      if (!rest[0]) throw new Error("usage: mf cancel TASK_ID");
      return print(await request({ type: "cancel", taskId: rest[0] }));
    case "events":
      return print(await request({ type: "events" }));
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
        "usage: mf start | stop | run [--wait S] [--stall S] [--bot NAME] [--background] FILE [ARGS] | wait TASK_ID | cancel TASK_ID | events | status | snapshot\n",
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
