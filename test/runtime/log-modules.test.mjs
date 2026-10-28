import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { startExplore, summarize as summarizeExplore } from "../../runtime/default-scripts/explore.mjs";
import { radarState, startRadar } from "../../runtime/default-scripts/radar.mjs";
import { startDanger } from "../../runtime/default-scripts/danger.mjs";

const posted = () => {
  const entries = [];
  return { entries, log: { post: async (data, opts = {}) => entries.push({ data, ...opts }) } };
};
const at = (s) => Date.UTC(2026, 9, 24, 12, 0, s);

test("explore logs only blocks it has not seen, and mf log sums them up", async () => {
  const { entries, log } = posted();
  const bot = { entity: { position: { x: 0.5, y: 64, z: 0.5 }, eyeHeight: 1.62 }, blockAt: () => null, game: { dimension: "overworld" } };
  let blocks = [
    { name: "stone", position: { x: 1, y: 64, z: 0 } },
    { name: "chest", position: { x: 2, y: 64, z: 0 } },
  ];
  let signs = [];
  const scan = () => ({
    blocks,
    signs,
    knownBounds: { min: { x: -1, y: 63, z: -1 }, max: { x: 2, y: 66, z: 1 } },
  });
  const explore = startExplore({ bot, log, scan, sampleMs: 60_000 });
  explore.scan();
  explore.scan(); // The same blocks again: nothing new.
  blocks = [...blocks, { name: "stone", position: { x: 3, y: 64, z: 0 } }];
  signs = [{ position: { x: 2, y: 65, z: 0 }, front: { known: true, text: "wool below" }, back: { known: true, text: "" } }];
  explore.scan();
  explore.close();
  await explore.flush();
  assert.deepEqual(
    entries.map((e) => [e.type, e.data.counts ?? e.data.signs.length]),
    [
      ["blocks", { stone: 1, chest: 1 }],
      ["blocks", { stone: 1 }],
      ["signs", 1],
    ],
  );
  const lines = summarizeExplore(
    entries.map((e, i) => ({ at: at(i), type: e.type, key: e.key, data: e.data })),
  );
  assert.deepEqual(lines, [
    "blocks not seen before, 2 scans from 12:00:00 to 12:00:01:",
    "  overworld: scanned x -1..2, y 63..66, z -1..1",
    "  stone 2 (1,64,0 3,64,0), chest 1 (2,64,0)",
    'sign 2,65,0 (12:00:02): "wool below"',
  ]);
});

test("radar logs arrivals, departures and changes, never every sample", async () => {
  const { entries, log } = posted();
  let radar = {
    players: [{ name: "Steve", position: { x: 10, y: 64, z: 3 }, team: "blue", relation: "opponent", visibility: "visible" }],
    named: [],
    entities: [
      { name: "zombie", distance: 12 },
      { name: "zombie", distance: 11 },
    ],
    drops: [],
  };
  const timers = [];
  const realSetInterval = globalThis.setInterval;
  globalThis.setInterval = (fn) => (timers.push(fn), 0);
  let sampleOptions;
  const running = startRadar({
    bot: {},
    log,
    sample: (_bot, options) => {
      sampleOptions = options;
      return { radar };
    },
  });
  globalThis.setInterval = realSetInterval;
  const tick = timers[0];
  tick();
  tick(); // Unchanged.
  assert.equal(sampleOptions.radar.entities, "list");
  radar = { ...radar, players: [{ ...radar.players[0], position: { x: 30, y: 64, z: 3 } }] };
  tick();
  radar = { ...radar, players: [], entities: [] };
  tick();
  running.close();
  await running.flush();
  assert.deepEqual(
    entries.map((e) => [e.type, e.key ?? null, e.data.name ?? null]),
    [
      ["appeared", null, "Steve"],
      ["mobs", "mobs", null],
      ["player", "player:Steve", "Steve"],
      ["left", null, "Steve"],
      ["mobs", "mobs", null],
    ],
  );
  assert.deepEqual(entries[0].data, { name: "Steve", at: [8, 64, 0], team: "blue", relation: "opponent", visibility: "visible" });
  assert.deepEqual(entries[1].data, { zombie: { count: 2, nearest: 8 } });
  assert.deepEqual(radarState({ players: [{ name: "a", position: { x: 1, y: 2, z: 3 } }] }, { step: 0 }).players.a.at, [1, 2, 3]);
});

test("radar preserves per-species nearest distances and marks mixed chunks ambiguous", () => {
  assert.deepEqual(
    radarState(
      {
        entities: [
          { name: "zombie", distance: 11 },
          { name: "cow", distance: 3 },
          { name: "zombie", distance: 6 },
        ],
      },
      { step: 1 },
    ).mobs,
    {
      zombie: { count: 2, nearest: 6 },
      cow: { count: 1, nearest: 3 },
    },
  );
  assert.deepEqual(
    radarState(
      {
        entityChunks: [
          { counts: { zombie: 1, cow: 1 }, nearest: 3 },
          { counts: { zombie: 2 }, nearest: 9 },
        ],
      },
      { step: 1 },
    ).mobs,
    { zombie: { count: 3 }, cow: { count: 1 } },
  );
});

test("unknown radar samples do not report departures or empty mobs", async () => {
  const { entries, log } = posted();
  const visible = {
    known: true,
    players: [{ name: "Steve", position: { x: 2, y: 64, z: 3 } }],
    named: [],
    entityChunks: [{ counts: { zombie: 1 }, nearest: 4 }],
    drops: [],
  };
  let radar = visible;
  const timers = [];
  const realSetInterval = globalThis.setInterval;
  globalThis.setInterval = (fn) => (timers.push(fn), 0);
  const running = startRadar({ bot: {}, log, sample: () => ({ radar }) });
  globalThis.setInterval = realSetInterval;
  const tick = timers[0];
  tick();
  radar = { known: false, players: [], named: [], entityChunks: [], drops: [] };
  tick();
  radar = visible;
  tick();
  running.close();
  await running.flush();

  assert.deepEqual(
    entries.map(({ type, data }) => [type, data.name ?? data]),
    [
      ["appeared", "Steve"],
      ["mobs", { zombie: { count: 1, nearest: 8 } }],
    ],
  );
});

test("danger: health events and risk alerts, urgent ones marked; hunger and air once each", async () => {
  const { entries, log } = posted();
  const bot = Object.assign(new EventEmitter(), {
    health: 20,
    food: 20,
    entity: { position: { x: 0, y: 64, z: 0 } },
    inventory: Object.assign(new EventEmitter(), { items: () => [], slots: [] }),
  });
  let state = { radar: { alerts: [] }, self: { food: 20, oxygen: 20 } };
  const timers = [];
  const realSetInterval = globalThis.setInterval;
  globalThis.setInterval = (fn) => (timers.push(fn), 0);
  const danger = startDanger({ bot, log, sample: () => state });
  globalThis.setInterval = realSetInterval;
  const tick = timers[0];
  state = {
    radar: { alerts: [{ id: 7, name: "creeper", position: { x: 2, y: 64, z: 0 }, distance: 2, reasons: ["swelling"] }] },
    self: { food: 5, oxygen: 6 },
  };
  tick();
  tick(); // The same alert, still hungry, still short of air: nothing new.
  bot.health = 5;
  bot.emit("health");
  await new Promise((done) => setTimeout(done, 300)); // The health burst settles.
  danger.close();
  await danger.flush();
  const kinds = entries.map((e) => [e.type, e.urgent ?? false]);
  assert.deepEqual(kinds.slice(0, 3), [
    ["alert", true],
    ["hungry", false],
    ["drowning", true],
  ]);
  assert.ok(kinds.some(([type, urgent]) => type === "critical_health" && urgent));
  assert.ok(entries.every((e) => !("observedAt" in e.data)));
});
