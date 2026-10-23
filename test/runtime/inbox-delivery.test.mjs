import test from "node:test";
import assert from "node:assert/strict";
import { Inbox } from "../../runtime/inbox/index.mjs";

const state = (inbox, key, data, origin = {}) =>
  inbox.post({ sessionId: "s", kind: "state", key, data, ...origin });

test("a state replaces only the same character's same process", () => {
  const inbox = new Inbox({ sessionId: "s" });
  state(inbox, "observation.current", "red, first", { bot: "red", generation: "g1" });
  state(inbox, "observation.current", "blue", { bot: "blue", generation: "g2" });
  state(inbox, "observation.current", "red, second", { bot: "red", generation: "g1" });
  // The restarted process of red does not replace what the old one saw.
  state(inbox, "observation.current", "red, restarted", { bot: "red", generation: "g3" });
  assert.deepEqual(
    inbox.drain().messages.map((message) => message.data),
    ["blue", "red, second", "red, restarted"],
  );
});

test("select picks urgent first and whole messages within the budget; commit removes only those", () => {
  const inbox = new Inbox({ sessionId: "s" });
  const delivered = [];
  inbox.post(
    { sessionId: "s", data: "a".repeat(300) },
    { onDelivered: () => delivered.push("big") },
  );
  inbox.post({ sessionId: "s", data: "small" });
  inbox.post({ sessionId: "s", data: "danger", priority: "urgent" });
  // danger (about 180 bytes) and the big one (about 480) fit; small does not.
  const batch = inbox.select({ maxBytes: 700 });
  assert.deepEqual(
    batch.messages.map((message) => String(message.data).slice(0, 6)),
    ["danger", "aaaaaa"],
  );
  assert.equal(batch.remaining, 1);
  // Nothing has left the queue until the caller has the result.
  assert.equal(inbox.items.length, 3);
  assert.deepEqual(delivered, []);
  inbox.post({ sessionId: "s", data: "later" });
  inbox.commit(batch);
  assert.deepEqual(delivered, ["big"]);
  assert.deepEqual(
    inbox.items.map((item) => item.message.data),
    ["small", "later"],
  );
});

test("one message larger than the budget is still taken, so it cannot block the queue", () => {
  const inbox = new Inbox({ sessionId: "s" });
  inbox.post({ sessionId: "s", data: "a".repeat(2000) });
  inbox.post({ sessionId: "s", data: "next" });
  const batch = inbox.select({ maxBytes: 100 });
  assert.equal(batch.messages.length, 1);
  assert.equal(batch.remaining, 1);
});

test("a batch never committed leaves its messages for the next one", () => {
  const inbox = new Inbox({ sessionId: "s" });
  inbox.post({ sessionId: "s", data: "kept" });
  inbox.select();
  assert.deepEqual(
    inbox.select().messages.map((message) => message.data),
    ["kept"],
  );
});

test("an inbox without expiry keeps messages and program status", () => {
  let now = 0;
  const inbox = new Inbox({ sessionId: "s", ttlMs: Infinity, now: () => now });
  inbox.post({ sessionId: "s", data: "kept" });
  inbox.setCurrent("phase", "walking");
  now = 1e12;
  assert.deepEqual(
    inbox.currentSnapshot().map((message) => message.data),
    ["walking"],
  );
  assert.deepEqual(
    inbox.drain().messages.map((message) => message.data),
    ["kept"],
  );
});
