import { EventEmitter } from "node:events";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
} from "node:fs";
import { join } from "node:path";

/** A source name that is safe as a file name: letters, digits, `_`, `-`. */
export const SOURCE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

export const logFile = (dir, source) => join(dir, `${source}.jsonl`);

/** The largest seq in the last line of each log file in dir (0 when none). */
function lastSeq(dir) {
  let max = 0;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".jsonl")) continue;
    let text;
    try {
      text = readFileSync(join(dir, name), "utf8");
    } catch {
      continue;
    }
    const line = text.trimEnd().split("\n").at(-1);
    try {
      max = Math.max(max, JSON.parse(line).seq ?? 0);
    } catch {}
  }
  return max;
}

/**
 * The log: every entry is appended, as one JSON line, to `<dir>/<source>.jsonl`
 * and never changed. Reading (what is new, summaries) is the reader's job
 * (view.mjs); the store only numbers the entries and tells the supervisor
 * about each one.
 *
 * An entry: { seq, at, source, type?, key?, urgent?, bot?, task?, label?, data }.
 * `seq` grows across all sources and across restarts in the same directory.
 *
 * Events: "entry" (every entry), "urgent" (entries with urgent: true).
 */
export class LogStore extends EventEmitter {
  constructor({
    dir,
    maxFileBytes = 20_000_000,
    now = Date.now,
    // A failed write is reported here; the entry still counts (and wakes).
    onError = (error) => console.error(`log: ${error.message}`),
  } = {}) {
    super();
    if (!dir) throw new Error("dir required");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    Object.assign(this, { dir, maxFileBytes, now, onError });
    this.seq = lastSeq(dir);
  }
  append({ source, type, key, urgent, bot, task, label, data } = {}) {
    if (typeof source !== "string" || !SOURCE.test(source))
      throw new Error("source must be letters, digits, '_' or '-' (at most 64)");
    if (data === undefined) throw new Error("data is required");
    const entry = {
      seq: ++this.seq,
      at: this.now(),
      source,
      ...(typeof type === "string" && type ? { type: type.slice(0, 80) } : {}),
      ...(typeof key === "string" && key ? { key: key.slice(0, 120) } : {}),
      ...(urgent === true ? { urgent: true } : {}),
      ...(typeof bot === "string" && bot ? { bot } : {}),
      ...(typeof task === "string" && task ? { task } : {}),
      ...(typeof label === "string" && label ? { label } : {}),
      data,
    };
    const file = logFile(this.dir, source);
    try {
      if (existsSync(file) && statSync(file).size > this.maxFileBytes)
        renameSync(file, join(this.dir, `${source}.1.jsonl`));
      appendFileSync(file, `${JSON.stringify(entry)}\n`);
    } catch (error) {
      this.onError(error);
    }
    this.emit("entry", entry);
    if (entry.urgent) this.emit("urgent", entry);
    return entry;
  }
}
