import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import lockfile from "proper-lockfile";
import { logFile } from "./store.mjs";

/**
 * Reading the log: what is new in each source since the reader last looked,
 * one section per source, through the source's summary module when it has
 * one (`<source>.view.json`, see LogClient.summary) and the generic rules
 * otherwise. The read position is `cursor.json` in the log directory: one
 * seq per source, moved only by a plain read (not --since, --all, --bot or
 * --peek)
 * and only once the result was printed (`commit`).
 */

const cursorFile = (dir) => join(dir, "cursor.json");

export function readCursor(dir) {
  try {
    const value = JSON.parse(readFileSync(cursorFile(dir), "utf8"));
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

async function writeCursor(dir, cursor) {
  const file = cursorFile(dir);
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(cursor)}\n`);
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

/** The sources that have a log file, in a stable order: runtime first. */
export function listSources(dir) {
  if (!existsSync(dir)) return [];
  const names = readdirSync(dir)
    .filter((name) => name.endsWith(".jsonl") && !/\.\d+\.jsonl$/.test(name))
    .map((name) => name.slice(0, -".jsonl".length));
  const first = ["runtime", "tasks", "chat"];
  return names.sort(
    (a, b) =>
      (first.includes(a) ? first.indexOf(a) : first.length) -
        (first.includes(b) ? first.indexOf(b) : first.length) || a.localeCompare(b),
  );
}

function parseLines(text) {
  const entries = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {}
  }
  return entries;
}

/** Every entry of a source, oldest first; `older` adds the retained rotated file. */
export function readEntries(dir, source, { older = false } = {}) {
  const read = (file) => {
    try {
      return parseLines(readFileSync(file, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
  };
  // Read current first: a concurrent rotation may move those entries into
  // .1 before it is read, so merge by sequence and drop that overlap.
  const entries = [...read(logFile(dir, source)), ...(older ? read(join(dir, `${source}.1.jsonl`)) : [])];
  const numbered = new Map();
  const unnumbered = [];
  for (const entry of entries) {
    if (Number.isSafeInteger(entry.seq)) numbered.set(entry.seq, entry);
    else unnumbered.push(entry);
  }
  return [...unnumbered, ...numbered.values()].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
}

export const clock = (at) => new Date(at).toISOString().slice(11, 19);

const json = (value) => {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

/**
 * One entry as a line: time, ! when urgent, type, character, program, data.
 * `oneBot` leaves the character out (the section is all one character's); a
 * program label that names the source (radar.mjs in `radar`) is left out too.
 */
export function entryLine(entry, { count = 1, lastAt, oneBot = false } = {}) {
  const data = entry.data;
  // The stop is said in front; the type is the entry's own when it has one.
  const { type: dataType, stop: _, ...rest } = data && typeof data === "object" && !Array.isArray(data) ? data : {};
  const type = entry.type ?? dataType ?? entry.key;
  const body = data && typeof data === "object" && !Array.isArray(data) ? rest : data;
  const label = entry.label && !entry.label.includes(entry.source) ? entry.label : null;
  const about = [oneBot ? null : entry.bot, label].filter(Boolean).join(", ");
  const text = typeof body === "string" ? body : Object.keys(body ?? {}).length ? json(body) : "";
  return [
    clock(entry.at),
    entry.urgent || data?.stop ? "!" : "-",
    ...(data?.stop ? [`stop: ${data.stop}`] : []),
    ...(type ? [type] : []),
    ...(about ? [`(${about})`] : []),
    ...(text ? [text] : []),
    ...(count > 1 ? [`×${count}, last ${clock(lastAt)}`] : []),
  ].join(" ");
}

/**
 * The generic view: an entry with a key is shown only in its newest
 * version; repeats in a row (same type, character and data) fold into one
 * line with a count.
 */
export function genericLines(entries, { oneBot = new Set(entries.map((e) => e.bot)).size <= 1 } = {}) {
  const newest = new Map();
  for (const entry of entries) if (entry.key) newest.set(`${entry.bot ?? ""}\n${entry.key}`, entry);
  const kept = entries.filter((entry) => !entry.key || newest.get(`${entry.bot ?? ""}\n${entry.key}`) === entry);
  const lines = [];
  let run = null;
  const flush = () => {
    if (run) lines.push(entryLine(run.first, { count: run.count, lastAt: run.lastAt, oneBot }));
    run = null;
  };
  for (const entry of kept) {
    const same = json([entry.type, entry.bot, entry.label, entry.urgent, entry.data]);
    if (run && run.same === same) {
      run.count++;
      run.lastAt = entry.at;
      continue;
    }
    flush();
    run = { same, first: entry, count: 1, lastAt: entry.at };
  }
  flush();
  return lines;
}

async function summaryOf(dir, source) {
  const file = join(dir, `${source}.view.json`);
  if (!existsSync(file)) return undefined;
  const { summarize } = JSON.parse(readFileSync(file, "utf8"));
  const module = await import(pathToFileURL(summarize).href);
  if (typeof module.summarize !== "function")
    throw new Error(`${summarize} exports no summarize function`);
  return module.summarize;
}

/** Keep the end of lines within `limit` bytes; say what was left out. */
function fit(lines, limit, source) {
  let bytes = 0;
  let start = lines.length;
  while (start > 0 && bytes + Buffer.byteLength(lines[start - 1]) + 1 <= limit) {
    bytes += Buffer.byteLength(lines[start - 1]) + 1;
    start--;
  }
  if (start === lines.length && lines.length) start--; // At least the newest line, even if long.
  return start
    ? [`(${start} earlier line${start === 1 ? "" : "s"} left out: mf log --source ${source} --all)`, ...lines.slice(start)]
    : lines;
}

/**
 * What `mf log` prints, and `commit()` to move the read position past it.
 *
 * Options: sources (names; default all), bot (one character), since (a time
 * in ms: entries from then on), all (everything kept), raw (no summary
 * modules), peek (do not move the read position), budget (bytes of output,
 * shared between the sources that have something).
 */
export async function readLog({
  dir,
  sources,
  bot,
  since,
  all = false,
  raw = false,
  peek = false,
  budget = 8000,
  now = Date.now,
} = {}) {
  const selection = selectEntries({ dir, sources, bot, since, all });
  const text = await renderLog({
    dir,
    ...selection,
    raw,
    budget,
    now,
  });
  return {
    text,
    async commit() {
      // One character's view leaves the others' entries unread.
      if (selection.fromCursor && !peek && !bot)
        await commitCursor(dir, selection.advances);
    },
  };
}

/** Select entries and the per-source cursor advances represented by this view. */
function selectEntries({ dir, sources, bot, since, all }) {
  const cursor = readCursor(dir);
  const known = listSources(dir);
  const wanted = sources?.length ? sources : known;
  const unknown = wanted.filter((source) => !known.includes(source));
  const fromCursor = since === undefined && !all;
  const sections = [];
  const advances = new Map();
  for (const source of wanted.filter((name) => known.includes(name))) {
    const entries = readEntries(dir, source, { older: true });
    const after = cursor[source] ?? 0;
    const shown = entries.filter(
      (entry) =>
        (!bot || !entry.bot || entry.bot === bot) &&
        (fromCursor ? entry.seq > after : since === undefined || entry.at >= since),
    );
    if (fromCursor && entries.length && entries.at(-1).seq > after)
      advances.set(source, entries.at(-1).seq);
    if (shown.length) sections.push({ source, entries: shown });
  }
  return { fromCursor, sections, unknown, known, advances };
}

/** Merge only this view's advances while serializing competing CLI commits. */
async function commitCursor(dir, advances) {
  if (!advances.size) return;
  const file = cursorFile(dir);
  const release = await lockfile.lock(file, {
    realpath: false,
    retries: { retries: 50, factor: 1.2, minTimeout: 5, maxTimeout: 50 },
  });
  try {
    const cursor = { ...readCursor(dir) };
    for (const [source, seq] of advances)
      cursor[source] = Math.max(cursor[source] ?? 0, seq);
    await writeCursor(dir, cursor);
  } finally {
    await release();
  }
}

/** Render selected entries without changing the read position. */
async function renderLog({ dir, sections, unknown, known, fromCursor, raw, budget, now }) {
  const share = sections.length ? Math.max(1000, Math.floor(budget / sections.length)) : budget;
  const out = [];
  for (const { source, entries } of sections) {
    let lines;
    let note = "";
    try {
      const summarize = raw ? undefined : await summaryOf(dir, source);
      if (summarize) {
        const value = await summarize(entries, { now: now() });
        lines = (Array.isArray(value) ? value : String(value ?? "").split("\n")).filter((line) => line !== "");
      }
    } catch (error) {
      note = ` (summary failed: ${error.message}; entries as they are)`;
    }
    lines ??= genericLines(entries);
    const span = entries.length > 1 ? `${clock(entries[0].at)}–${clock(entries.at(-1).at)}` : clock(entries[0].at);
    out.push(`== ${source}: ${entries.length} ${fromCursor ? "new" : "shown"}, ${span}${note} ==`);
    out.push(...fit(lines, share, source));
  }
  if (unknown.length) out.push(`(no log yet for: ${unknown.join(", ")}; sources: ${known.join(", ") || "none"})`);
  if (!sections.length)
    out.unshift(fromCursor ? "nothing new since you last read the log" : "nothing in the log for that");
  return `${out.join("\n")}\n`;
}
