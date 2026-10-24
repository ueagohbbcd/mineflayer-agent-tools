import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Inbox, localInboxClient } from "../../runtime/inbox/index.mjs";
import { TaskManager } from "../../runtime/tasks/index.mjs";
import { startObserver } from "../../runtime/observation/observer.mjs";
import { runObserver } from "../../runtime/default-scripts/observer.mjs";

let noScan;
/** An observer.json that turns off the block scan, which the fakes do not serve. */
async function noScanConfig() {
  if (!noScan) {
    const dir = await mkdtemp(join(tmpdir(), "observer-config-"));
    noScan = join(dir, "observer.json");
    await writeFile(
      noScan,
      JSON.stringify({ recentBlocks: { enabled: false } }),
    );
  }
  return noScan;
}

async function until(check, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() >= deadline) assert.fail("Timed out waiting for observer");
    await delay(5);
  }
}
function fakeBot() {
  const bot = new EventEmitter();
  bot.health = 20;
  bot.closed = false;
  bot.getSessionState = async () => ({ state: "running" });
  return bot;
}
function fakeSample(bot, { now = Date.now, connectionStatus, local } = {}) {
  return {
    type: "observation",
    observedAt: now(),
    freshness: { status: connectionStatus ?? "fresh" },
    self: bot ? { health: bot.health } : null,
    ...(local === false ? {} : { local: { around: null } }),
  };
}
function fakeWatch(bot, { post, now }) {
  const damage = () =>
    post({
      kind: "event",
      priority: "urgent",
      data: { type: "observation.health", health: bot.health },
    });
  bot.on("damage", damage);
  return {
    sample: (options) => fakeSample(bot, { now, ...options }),
    close: () => bot.off("damage", damage),
  };
}
const report = (inbox) =>
  inbox.items.find((item) => item.message.key === "observation.current")
    ?.message.data;

async function observe(t, bot, inbox, overrides = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "observer-"));
  const observer = await startObserver({
    bot,
    inbox: localInboxClient(inbox),
    cwd,
    env: { MF_OBSERVER_CONFIG: await noScanConfig() },
    intervalMs: 5,
    watch: fakeWatch,
    sample: fakeSample,
    onError: (error) => assert.fail(error),
    ...overrides,
  });
  t.after(async () => {
    observer.close();
    await rm(cwd, { recursive: true, force: true });
  });
  return observer;
}

for (const outcome of ["overflow", "expired"]) {
  test(`observer retries unchanged state after ${outcome}`, async (t) => {
    let time = 0;
    const inbox = new Inbox({
      sessionId: `observer-${outcome}`,
      maxItems: 1,
      ttlMs: 10,
      now: () => time,
    });
    const observer = await observe(t, fakeBot(), inbox, { intervalMs: 60000 });
    await until(() => report(inbox));
    const id = inbox.items[0].id;
    if (outcome === "overflow") {
      await localInboxClient(inbox).send({
        kind: "event",
        data: { type: "other" },
      });
    } else {
      time = 11;
      inbox.drain();
    }
    await until(() => inbox.outcome(id) === outcome);
    await delay(0); // Allow the asynchronous delivery receipt to reach the observer.
    assert.equal(report(inbox), undefined, "loss does not retry immediately");
    observer.publish();
    await until(() => report(inbox));
    assert.equal(report(inbox).changes.self.health, 20);
    inbox.drain();
    await delay(0);
    observer.publish();
    await delay(0);
    assert.equal(report(inbox), undefined, "delivered state stays suppressed");
  });
}

for (const failure of ["rejected", "throw"]) {
  test(`observer retries unchanged state after send is ${failure}`, async (t) => {
    const inbox = new Inbox({ sessionId: `observer-send-${failure}` });
    const client = localInboxClient(inbox);
    let sends = 0;
    const errors = [];
    const observer = await observe(t, fakeBot(), inbox, {
      intervalMs: 60000,
      onError: (error) => errors.push(error),
      inbox: {
        ...client,
        async send(message) {
          sends++;
          if (sends === 1) {
            if (failure === "throw") throw new Error("send unavailable");
            return { accepted: false };
          }
          return client.send(message);
        },
      },
    });
    await delay(0);
    assert.equal(sends, 1, "failure does not start an immediate retry loop");
    observer.publish();
    await until(() => report(inbox));
    assert.equal(sends, 2);
    assert.equal(report(inbox).changes.self.health, 20);
    assert.equal(errors.length, failure === "throw" ? 1 : 0);
  });
}

test("late receipts cannot erase a newer report with the same state", async (t) => {
  const bot = fakeBot();
  const sends = [];
  const receipts = [];
  const inbox = new Inbox({ sessionId: "observer-late" });
  const observer = await observe(t, bot, inbox, {
    intervalMs: 60000,
    inbox: {
      async send(message) {
        sends.push(message);
        return { accepted: true, id: sends.length };
      },
      delivery(id) {
        return new Promise((resolve) => (receipts[id] = resolve));
      },
    },
  });
  await until(() => receipts[1]);
  bot.health = 12;
  observer.publish();
  await until(() => receipts[2]);
  bot.health = 20;
  observer.publish();
  await until(() => receipts[3]);
  receipts[1]({ outcome: "overflow" });
  await delay(0);
  observer.publish();
  assert.equal(
    sends.length,
    3,
    "old loss does not clear the newer same signature",
  );
  receipts[3]({ outcome: "delivered" });
  await delay(0);
  receipts[2]({ outcome: "delivered" });
  await delay(0);
  observer.publish();
  assert.equal(sends.length, 3, "late delivery does not regress the baseline");
});

test("a report taken back that reached the model anyway still sets the baseline", async (t) => {
  const bot = fakeBot();
  const sends = [];
  const receipts = [];
  const retracted = [];
  const observer = await observe(
    t,
    bot,
    new Inbox({ sessionId: "correction" }),
    {
      intervalMs: 60000,
      inbox: {
        async send(message) {
          sends.push(message);
          return { accepted: true, id: sends.length };
        },
        delivery(id) {
          return new Promise((resolve) => (receipts[id] = resolve));
        },
        async retract(id) {
          retracted.push(id);
          return { id, retracted: false };
        },
      },
    },
  );
  await until(() => receipts[1]);
  receipts[1]({ outcome: "delivered" });
  await delay(0);
  bot.health = 12;
  observer.publish();
  await until(() => receipts[2]);
  // Back to what the model saw: the report is taken back, nothing is sent.
  bot.health = 20;
  observer.publish();
  assert.deepEqual(retracted, [2]);
  assert.equal(sends.length, 2);
  // It had reached the model first: the model now believes 12.
  receipts[2]({ outcome: "delivered" });
  await delay(0);
  observer.publish();
  await until(() => receipts[3]);
  assert.deepEqual(
    sends.map((message) => message.data.changes.self.health),
    [20, 12, 20],
  );
});

test("default observer reports state changes only after the previous report was delivered", async (t) => {
  const inbox = new Inbox({ sessionId: "observer" });
  const bot = fakeBot();
  const observer = await observe(t, bot, inbox);

  await until(() => report(inbox));
  let batch = inbox.drain();
  const [baseline] = batch.messages;
  assert.equal(baseline.source, "program", "an ordinary inbox client");
  assert.equal(baseline.data.type, "observation.snapshot");
  assert.equal(baseline.data.changes.self.health, 20);
  assert.equal(baseline.data.changes.connection.status, "fresh");
  assert.equal(
    "local" in baseline.data.changes,
    false,
    "local is on request only",
  );
  await delay(40);
  assert.equal(inbox.items.length, 0, "nothing changed, nothing is reported");

  bot.health = 12;
  await until(() => report(inbox));
  assert.equal(inbox.items.length, 1, "one replaceable report");
  // A section that changes and then changes back before delivery is taken
  // back instead of describing a state that no longer holds.
  bot.health = 20;
  await until(() => !report(inbox));
  await delay(40);
  assert.equal(inbox.items.length, 0);

  bot.health = 9;
  await until(() => report(inbox));
  batch = inbox.drain();
  assert.deepEqual(batch.messages[0].data.changes, { self: { health: 9 } });

  bot.emit("end", "Server closed");
  await until(() => report(inbox));
  assert.equal(report(inbox).changes.connection.status, "disconnected");
  observer.close();
  assert.equal(bot.listenerCount("damage"), 0);
  assert.equal(bot.listenerCount("end"), 0);
});

test("observer events share one report, urgent while it holds an urgent one", async (t) => {
  const inbox = new Inbox({ sessionId: "observer-urgent" });
  const bot = fakeBot();
  await observe(t, bot, inbox);
  await until(() => report(inbox));
  inbox.drain();

  const events = () =>
    inbox.items.find((item) => item.message.key === "observation.events")?.message;
  bot.health = 9;
  bot.emit("damage");
  bot.health = 7;
  bot.emit("damage");
  await until(() => events()?.data.events.length === 2);
  assert.equal(events().priority, "urgent");
  assert.deepEqual(events().data.events.map((event) => event.health), [9, 7]);
  inbox.drain();
  await delay(10);
  bot.health = 5;
  bot.emit("damage");
  await until(() => events());
  assert.deepEqual(events().data.events.map((event) => event.health), [5]);
});

test("native observer reports bot disconnect and removes its listeners on close", async () => {
  const inbox = new Inbox({ sessionId: "observer-retry" });
  const bot = fakeBot();
  const running = await runObserver({
    bot,
    inbox: localInboxClient(inbox),
    env: { MF_OBSERVER_CONFIG: await noScanConfig() },
    watch: fakeWatch,
    sample: fakeSample,
  });
  await until(() => report(inbox));
  bot.emit("end", "Server closed");
  await until(
    () => report(inbox)?.changes?.connection?.status === "disconnected",
  );
  running.close();
  assert.equal(bot.listenerCount("end"), 0);
});

test("observer.json events and the events option reach the event watcher", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "observer-events-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(
    join(cwd, "observer.json"),
    JSON.stringify({
      recentBlocks: { enabled: false },
      events: { urgentDamageLoss: 3, criticalHealth: 8 },
    }),
  );
  let seen;
  const observer = await startObserver({
    bot: fakeBot(),
    inbox: localInboxClient(new Inbox({ sessionId: "observer-events" })),
    cwd,
    env: {},
    events: { urgentDamageLoss: 2 },
    watch: (bot, options) => {
      seen = options;
      return fakeWatch(bot, options);
    },
    sample: fakeSample,
  });
  t.after(() => observer.close());
  await until(() => seen);
  assert.equal(seen.urgentDamageLoss, 2, "the option overrides the file");
  assert.equal(seen.criticalHealth, 8);
});
