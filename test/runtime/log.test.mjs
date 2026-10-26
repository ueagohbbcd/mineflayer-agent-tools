import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LogClient,
  LogStore,
  createLogServer,
  genericLines,
  readLog,
} from "../../runtime/log/index.mjs";

async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), "mf-log-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const at = (h, m, s) => Date.UTC(2026, 9, 24, h, m, s);

test("entries go to one file per source, numbered across sources and restarts", async (t) => {
  const dir = await tempDir(t);
  let now = at(12, 0, 0);
  const store = new LogStore({ dir, now: () => now });
  const urgent = [];
  store.on("urgent", (entry) => urgent.push(entry.seq));
  store.append({ source: "chat", type: "chat", data: { text: "hi" } });
  now += 1000;
  store.append({ source: "runtime", type: "character.died", urgent: true, bot: "red1", data: { stop: "death" } });
  assert.throws(() => store.append({ source: "../x", data: 1 }), /source/);
  assert.throws(() => store.append({ source: "chat" }), /data/);
  assert.deepEqual(urgent, [2]);
  const lines = (await readFile(join(dir, "chat.jsonl"), "utf8")).trim().split("\n");
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), {
    seq: 1,
    at: at(12, 0, 0),
    source: "chat",
    type: "chat",
    data: { text: "hi" },
  });
  // A new store in the same directory goes on from the last number.
  const again = new LogStore({ dir });
  assert.equal(again.append({ source: "chat", data: "x" }).seq, 3);
});

test("mf log shows what is new per source, once, and the read position survives", async (t) => {
  const dir = await tempDir(t);
  let now = at(12, 0, 0);
  const store = new LogStore({ dir, now: () => now });
  store.append({ source: "chat", type: "chat", data: { text: "one" } });
  store.append({ source: "runtime", type: "character.died", urgent: true, bot: "red1", data: { stop: "death" } });
  now += 5000;
  store.append({ source: "chat", type: "chat", data: { text: "two" } });

  const first = await readLog({ dir });
  assert.equal(
    first.text,
    [
      "== runtime: 1 new, 12:00:00 ==",
      "12:00:00 ! stop: death character.died",
      "== chat: 2 new, 12:00:00–12:00:05 ==",
      '12:00:00 - chat {"text":"one"}',
      '12:00:05 - chat {"text":"two"}',
      "",
    ].join("\n"),
  );
  // Not read until it was printed.
  assert.match((await readLog({ dir })).text, /chat: 2 new/);
  first.commit();
  assert.equal((await readLog({ dir })).text, "nothing new since you last read the log\n");

  store.append({ source: "chat", type: "chat", data: { text: "three" } });
  // --peek and --source leave the rest unread.
  const peek = await readLog({ dir, peek: true });
  peek.commit();
  const runtimeOnly = await readLog({ dir, sources: ["runtime", "nope"] });
  assert.match(runtimeOnly.text, /^nothing new/);
  assert.match(runtimeOnly.text, /no log yet for: nope/);
  runtimeOnly.commit();
  assert.match((await readLog({ dir })).text, /chat: 1 new[^]*three/);
  // --all shows everything kept, read or not, and moves nothing.
  const all = await readLog({ dir, all: true });
  assert.match(all.text, /chat: 3 shown/);
});

test("interleaved log commits merge only their sources and never rewind", async (t) => {
  const dir = await tempDir(t);
  const store = new LogStore({ dir, now: () => at(12, 0, 0) });
  store.append({ source: "chat", data: "one" });
  store.append({ source: "runtime", data: "two" });

  const chat = await readLog({ dir, sources: ["chat"] });
  assert.deepEqual(Object.keys(chat).sort(), ["commit", "text"]);
  const runtime = await readLog({ dir, sources: ["runtime"] });
  runtime.commit();
  chat.commit();
  assert.deepEqual(JSON.parse(await readFile(join(dir, "cursor.json"), "utf8")), {
    chat: 1,
    runtime: 2,
  });

  store.append({ source: "chat", data: "three" });
  const olderChatRead = await readLog({ dir, sources: ["chat"] });
  store.append({ source: "chat", data: "four" });
  const newerChatRead = await readLog({ dir, sources: ["chat"] });
  newerChatRead.commit();
  olderChatRead.commit();
  assert.deepEqual(JSON.parse(await readFile(join(dir, "cursor.json"), "utf8")), {
    chat: 4,
    runtime: 2,
  });
  assert.equal(
    (await readLog({ dir, sources: ["chat"] })).text,
    "nothing new since you last read the log\n",
  );
});

test("the generic view keeps the newest per key and folds repeats", () => {
  const lines = genericLines([
    { seq: 1, at: at(1, 0, 0), source: "s", key: "state", data: { hp: 20 } },
    { seq: 2, at: at(1, 0, 1), source: "s", type: "noPath", data: { goal: "a" } },
    { seq: 3, at: at(1, 0, 2), source: "s", type: "noPath", data: { goal: "a" } },
    { seq: 4, at: at(1, 0, 3), source: "s", type: "noPath", data: { goal: "a" } },
    { seq: 5, at: at(1, 0, 4), source: "s", key: "state", data: { hp: 12 } },
    { seq: 6, at: at(1, 0, 5), source: "s", key: "state", bot: "b2", data: { hp: 3 } },
  ]);
  assert.deepEqual(lines, [
    '01:00:01 - noPath {"goal":"a"} ×3, last 01:00:03',
    '01:00:04 - state {"hp":12}',
    '01:00:05 - state (b2) {"hp":3}',
  ]);
});

test("a source's own summary shapes its section; a broken one falls back", async (t) => {
  const dir = await tempDir(t);
  const store = new LogStore({ dir, now: () => at(9, 0, 0) });
  for (const n of [3, 4]) store.append({ source: "count", data: { n } });
  store.append({ source: "broken", data: { n: 1 } });
  const good = join(dir, "sum.mjs");
  await writeFile(good, "export const summarize = (entries) => `total ${entries.reduce((a, e) => a + e.data.n, 0)}`;");
  const bad = join(dir, "bad.mjs");
  await writeFile(bad, "export const summarize = () => { throw new Error('nope'); };");
  await writeFile(join(dir, "count.view.json"), JSON.stringify({ summarize: good }));
  await writeFile(join(dir, "broken.view.json"), JSON.stringify({ summarize: bad }));
  const { text } = await readLog({ dir });
  assert.match(text, /== count: 2 new, 09:00:00–09:00:00 ==\ntotal 7\n/);
  assert.match(text, /== broken: 1 new, 09:00:00 \(summary failed: nope; entries as they are\) ==\n09:00:00 - \{"n":1\}/);
  assert.match((await readLog({ dir, raw: true, all: true })).text, /\{"n":3\}/);
});

test("a long section keeps its newest lines and says how to see the rest", async (t) => {
  const dir = await tempDir(t);
  const store = new LogStore({ dir, now: () => at(9, 0, 0) });
  for (let i = 0; i < 200; i++) store.append({ source: "chat", data: { text: `line ${i} ${"x".repeat(40)}` } });
  const { text } = await readLog({ dir, budget: 2000 });
  const lines = text.trim().split("\n");
  assert.match(lines[1], /^\(\d+ earlier lines left out: mf log --source chat --all\)$/);
  assert.match(lines.at(-1), /line 199/);
  assert.ok(Buffer.byteLength(text) < 2300);
});

test("--bot shows one character and leaves the read position alone", async (t) => {
  const dir = await tempDir(t);
  const store = new LogStore({ dir, now: () => at(9, 0, 0) });
  store.append({ source: "runtime", bot: "red1", data: { stop: "death" } });
  store.append({ source: "runtime", bot: "red2", data: { stop: "death" } });
  const red1 = await readLog({ dir, bot: "red1" });
  assert.match(red1.text, /runtime: 1 new/);
  red1.commit();
  assert.match((await readLog({ dir })).text, /runtime: 2 new/);
});

test("a program writes through LogClient over the socket; describe adds who wrote it", async (t) => {
  const dir = await tempDir(t);
  const store = new LogStore({ dir });
  const socketPath = join(dir, "log.sock");
  const server = await createLogServer({
    store,
    socketPath,
    describe: (entry) => ({ ...entry, label: entry.task === "t1" ? "fish.mjs" : undefined }),
  });
  t.after(() => server.close());
  const urgent = [];
  store.on("urgent", (entry) => urgent.push(entry.type));
  const client = new LogClient({ source: "fishing", socketPath, dir, task: "t1", bot: "red1" });
  assert.deepEqual(await client.post({ caught: "cod" }), { seq: 1 });
  await client.post({ left: 3 }, { key: "bait" });
  await client.post({ seen: "creeper" }, { type: "danger", urgent: true });
  await assert.rejects(new LogClient({ source: "no/slash", socketPath }).post({}), /source/);
  assert.deepEqual(urgent, ["danger"]);
  const summary = join(dir, "fish-summary.mjs");
  await writeFile(summary, "export const summarize = (e) => [`${e.length} fishing entries`];");
  client.summary(summary);
  const { text } = await readLog({ dir });
  assert.match(text, /^== fishing: 3 new, [^\n]* ==\n3 fishing entries\n$/);
  const raw = await readLog({ dir, raw: true, all: true });
  assert.match(raw.text, / ! danger \(fish\.mjs\) \{"seen":"creeper"\}/);
  assert.match(raw.text, / - bait \(fish\.mjs\) \{"left":3\}/);
});
