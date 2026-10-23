import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import {
  Inbox,
  InboxClient,
  inboxSlot,
  localInboxClient,
} from "../../runtime/inbox/index.mjs";
import { socketInbox } from "./helpers/inbox-socket.mjs";

const stop = (message) => Boolean(message.data?.stop);

test("kept messages are never dropped, never expire and always fit a result", () => {
  let time = 0;
  const inbox = new Inbox({ sessionId: "keep", maxItems: 3, ttlMs: 10, keep: stop, now: () => time });
  const post = (data, options = {}) => inbox.post({ sessionId: "keep", data, ...options });
  post({ stop: "death", text: "x".repeat(300) });
  for (let i = 0; i < 5; i++) post({ n: i });
  assert.equal(inbox.items.length, 3);
  assert.equal(inbox.items[0].message.data.stop, "death", "overflow took the others");
  time = 100;
  const batch = inbox.select({ maxBytes: 1 });
  assert.equal(batch.messages.length, 1, "the rest expired");
  assert.equal(batch.messages[0].data.stop, "death");
  post({ n: "fresh" }, { priority: "urgent" });
  const both = inbox.select({ maxBytes: 1 });
  assert.deepEqual(
    both.messages.map((message) => message.data.stop ?? message.data.n),
    ["death"],
    "kept ones come first and do not use the budget; one more never fits",
  );
});

test("retract takes back an unread message without onLost", () => {
  const inbox = new Inbox({ sessionId: "retract" });
  let lost = 0;
  const { id } = inbox.post({ sessionId: "retract", data: 1 }, { onLost: () => lost++ });
  assert.equal(inbox.retract(id), true);
  assert.equal(inbox.outcome(id), "retracted");
  assert.equal(inbox.retract(id), false);
  assert.equal(lost, 0);
  assert.equal(inbox.items.length, 0);
});

test("a state update with a shorter delay makes it readable sooner", () => {
  let time = 0;
  const inbox = new Inbox({ sessionId: "sooner", now: () => time });
  const upsert = (data, minDeliveryDelayMs) =>
    inbox.post({ sessionId: "sooner", kind: "state", key: "k", data, minDeliveryDelayMs });
  upsert(1, 30000);
  assert.equal(inbox.pending, false);
  assert.deepEqual(inbox.select().accumulating, ["k"]);
  time = 10;
  upsert(2, 0);
  assert.equal(inbox.pending, true);
  assert.deepEqual(inbox.drain().messages.map((message) => message.data), [2]);
});

test("retract and signals over the socket", async (t) => {
  const inbox = new Inbox({ sessionId: "ipc" });
  const { socketPath } = await socketInbox(t, inbox);
  const client = new InboxClient({ socketPath, sessionId: "ipc" });
  const { id } = await client.post({ n: 1 });
  assert.deepEqual(await client.retract(id), { id, retracted: true });
  assert.deepEqual(await client.retract(id), { id, retracted: false });
  assert.equal(inbox.items.length, 0);

  const { last } = await client.signals(0);
  const waiting = client.signals(last, { waitMs: 2000 });
  await delay(50);
  inbox.signal("full");
  const { signals } = await waiting;
  assert.deepEqual(signals.map((signal) => signal.type), ["full"]);
});

test("a slot keeps one report: urgent while it holds an urgent entry, empty again after a read", async () => {
  const inbox = new Inbox({ sessionId: "slot" });
  const delivered = [];
  const slot = inboxSlot(localInboxClient(inbox), "lines", {
    render: (values) => ({ type: "lines", values }),
  });
  slot.put(1, "a");
  slot.put(2, "b", { urgent: true, onDelivered: () => delivered.push("b") });
  await slot.flush();
  assert.equal(inbox.items.length, 1);
  assert.equal(inbox.items[0].message.priority, "urgent");
  assert.deepEqual(inbox.items[0].message.data.values, ["a", "b"]);
  inbox.drain();
  await delay(10);
  assert.deepEqual(delivered, ["b"]);
  assert.equal(slot.size, 0);

  slot.put(3, "c");
  await slot.flush();
  assert.equal(inbox.items[0].message.priority, "normal");
  assert.deepEqual(inbox.items[0].message.data.values, ["c"]);
  // Taking the last entry back takes the report back.
  slot.delete(3);
  await slot.flush();
  assert.equal(inbox.items.length, 0);
  slot.close();
});

test("a slot entry added while the model reads an older version stays", async () => {
  const inbox = new Inbox({ sessionId: "slot-race" });
  const slot = inboxSlot(localInboxClient(inbox), "lines");
  slot.put(1, "old");
  await slot.flush();
  const batch = inbox.select();
  slot.put(2, "new");
  await slot.flush();
  inbox.commit(batch); // The old version was replaced: nothing counts as read.
  await delay(10);
  assert.deepEqual(inbox.items.map((item) => item.message.data), [["old", "new"]]);
  inbox.drain();
  await delay(10);
  assert.equal(slot.size, 0);
  slot.close();
});
