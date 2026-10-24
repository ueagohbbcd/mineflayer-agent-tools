import test from "node:test";
import assert from "node:assert/strict";
import { createTrendWatch } from "../../runtime/observation/trend-watch.mjs";

const run = (watch, seconds, at) => {
  const found = [];
  for (let s = 0; s <= seconds; s++) found.push(...watch.sample(at(s)));
  return found;
};

test("standing still for minutes is reported once, and walking off re-arms it", () => {
  const watch = createTrendWatch();
  const still = run(watch, 400, (s) => ({
    t: s * 1000,
    position: { x: 0.2 * Math.sin(s), y: 64, z: 0 },
    inventory: "1:1",
  }));
  assert.deepEqual(
    still.map((f) => f.type),
    ["no_progress"],
  );
  assert.equal(still[0].urgent, false);
  const walked = run(watch, 30, (s) => ({
    t: (401 + s) * 1000,
    position: { x: s * 4, y: 64, z: 0 },
    inventory: "1:1",
  }));
  assert.deepEqual(walked, []);
});

test("an inventory change or a dig counts as progress", () => {
  const watch = createTrendWatch();
  const found = run(watch, 400, (s) => {
    if (s % 100 === 50)
      watch.dig({ t: s * 1000, position: { x: s, y: 60, z: 0 } });
    return {
      t: s * 1000,
      position: { x: 0, y: 64, z: 0 },
      inventory: `1:${Math.floor(s / 120)}`,
    };
  });
  assert.deepEqual(found, []);
});

test("walking far over a few cells is circling; walking into a wall is reported", () => {
  const circling = createTrendWatch();
  const found = run(circling, 200, (s) => ({
    t: s * 1000,
    position: { x: 2 * Math.cos(s), y: 64, z: 2 * Math.sin(s) },
  }));
  assert.ok(found.some((f) => f.type === "circling"));
  const wall = createTrendWatch();
  const pressed = run(wall, 25, (s) => ({
    t: s * 1000,
    position: { x: 10, y: 64, z: 10 },
    moving: true,
    collided: true,
  }));
  assert.deepEqual(
    pressed.map((f) => f.type),
    ["against_wall"],
  );
});

test("intermittent wall collisions accumulate across brief releases and re-arm after the window expires", () => {
  const watch = createTrendWatch();
  const contact = (s, moving) => watch.sample({
    t: s * 1000,
    position: { x: 10, y: 64, z: 10 },
    moving,
    collided: moving,
  }).filter((finding) => finding.type === "against_wall");
  const found = [];
  for (let s = 0; s <= 29; s++)
    found.push(...contact(s, s > 0 && s % 5 !== 0)); // 4 s pressing, 1 s released
  assert.equal(found.length, 1);
  assert.equal(found[0].seconds, 20);
  assert.equal(found[0].windowSeconds, 30);
  for (let s = 30; s <= 60; s++)
    assert.deepEqual(contact(s, false), [], "do not repeat while wall contact decays");
  const again = [];
  for (let s = 61; s <= 90; s++)
    again.push(...contact(s, s % 5 !== 0));
  assert.equal(again.length, 1, "a new independent episode can report");
});

test("wall time is not invented across a missing sampling interval", () => {
  const watch = createTrendWatch({ wallMs: 3000, wallWindowMs: 30000 });
  const pos = { x: 0, y: 64, z: 0 };
  const sample = (t) => watch.sample({ t, position: pos, moving: true, collided: true });
  assert.deepEqual(sample(0), []);
  assert.deepEqual(sample(25000), [], "a 25 s observation gap is not 25 s of wall contact");
  assert.deepEqual(sample(26000), []);
  assert.deepEqual(sample(27000), []);
  assert.equal(sample(28000)[0]?.type, "against_wall");
});

test("repeated deaths in one place are urgent; repeated digs and chat are not", () => {
  const watch = createTrendWatch();
  assert.deepEqual(watch.death({ t: 0, position: { x: 0, y: 60, z: 0 } }), []);
  const deaths = watch.death({ t: 60_000, position: { x: 5, y: 60, z: 3 } });
  assert.equal(deaths[0].type, "repeat_death");
  assert.equal(deaths[0].urgent, true);
  assert.deepEqual(
    watch.death({ t: 70_000, position: { x: 500, y: 60, z: 0 } }),
    [],
  );
  const block = { x: 1.5, y: 63, z: 2.5 };
  watch.dig({ t: 0, position: block });
  watch.dig({ t: 1000, position: block });
  assert.equal(watch.dig({ t: 2000, position: block })[0].type, "repeat_dig");
  assert.deepEqual(watch.dig({ t: 3000, position: block }), [], "once");
  watch.chat({ t: 0, text: "help" });
  watch.chat({ t: 1, text: "help" });
  const chat = watch.chat({ t: 2, text: "help" });
  assert.equal(chat[0].type, "repeat_chat");
  assert.equal(chat[0].urgent, false);
});

test("the background watchdog logs each finding once, urgent only for repeated deaths", async (t) => {
  const { EventEmitter } = await import("node:events");
  const { startTrendWatchdog } =
    await import("../../runtime/default-scripts/watchdog.mjs");
  const bot = new EventEmitter();
  bot.username = "arena_red1";
  bot.entity = { position: { x: 0, y: 64, z: 0 } };
  bot.inventory = { items: () => [] };
  const posted = [];
  const running = startTrendWatchdog({
    bot,
    log: { post: async (data, opts) => posted.push({ data, ...opts }) },
    sampleMs: 60_000,
  });
  t.after(() => running.close());
  bot.emit("death");
  bot.emit("death");
  bot.emit("chat", "someone", "hi");
  for (let i = 0; i < 3; i++) bot.emit("chat", "arena_red1", "wool?");
  await running.flush();
  assert.deepEqual(
    posted.map((p) => [p.type, p.urgent ?? false]),
    [
      ["repeat_death", true],
      ["repeat_chat", false],
    ],
  );
  assert.match(posted[0].data.message, /Died 2 times/);
});
