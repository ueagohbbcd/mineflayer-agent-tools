import test from "node:test";
import assert from "node:assert/strict";
import { sampleEntities, watchEntities } from "../../examples/entity-radar.mjs";
const entity = (id, x) => ({
  id,
  type: "player",
  username: `p${id}`,
  position: { x, y: 0, z: 0 },
  velocity: { x: -1, y: 0, z: 0 },
});
function fixture() {
  return {
    entity: entity(1, 0),
    entities: {
      1: entity(1, 0),
      2: entity(2, 3),
      3: entity(3, 2),
      4: entity(4, 50),
    },
  };
}
test("radar excludes self, bounds and sorts observed entities without inventing hostility", () => {
  const bot = fixture(),
    sample = sampleEntities(bot, { limit: 1, now: 123 });
  assert.equal(sample.total, 2);
  assert.equal(sample.omitted, 1);
  assert.equal(sample.entities[0].id, 3);
  assert.equal(sample.entities[0].relative.x, 2);
  assert.equal(sample.sampledAt, 123);
  bot.entities[3].position.x = 9;
  assert.equal(sample.entities[0].position.x, 2);
});
test("radar logs a sample only when it changed, under one key", async () => {
  const bot = fixture(),
    controller = new AbortController();
  let rounds = 0;
  const posted = [];
  await watchEntities(
    bot,
    {
      async post(data, options) {
        posted.push({ data, options });
      },
    },
    {
      intervalMs: 1,
      signal: controller.signal,
      judge: () => {
        if (++rounds === 2) bot.entities = {};
        if (rounds === 4) controller.abort();
        return null;
      },
    },
  );
  // Rounds 1 and 2 saw the same entities; rounds 3 and 4 saw none.
  assert.equal(posted.length, 2);
  assert.deepEqual(posted.map((p) => p.options.key), ["nearby.entities", "nearby.entities"]);
  assert.equal(posted[0].data.total, 2);
  assert.deepEqual(posted[1].data.entities, []);
});
test("a continuing threat is deduplicated even after its cooldown", async () => {
  const controller = new AbortController();
  let samples = 0,
    judgments = 0;
  await watchEntities(
    fixture(),
    {
      async post(data, options) {
        if (!options?.urgent) return;
        judgments++;
        assert.equal(data.question, "Reassess?");
      },
    },
    {
      intervalMs: 5,
      cooldownMs: 1,
      signal: controller.signal,
      judge: () => {
        if (++samples === 3) controller.abort();
        return { question: "Reassess?" };
      },
    },
  );
  assert.equal(samples, 3);
  assert.equal(judgments, 1);
});
