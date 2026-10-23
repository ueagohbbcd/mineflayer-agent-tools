import test from "node:test";
import assert from "node:assert/strict";
test("the observation queries re-export the tree query", async () => {
  const sharedQueries = await import("../../queries.mjs");
  const queries = await import("../../runtime/observation/queries.mjs");
  assert.equal(queries.queryTreeCandidate, sharedQueries.queryTreeCandidate);
  const result = queries.queryTreeCandidate({
    blockAt: ({ x, y, z }) => ({
      name: x === 0 && y === 0 && z === 0 ? "oak_log" : "air",
    }),
    seed: { x: 0, y: 0, z: 0 },
  });
  assert.equal(result.status, "candidate");
  assert.equal(result.logs.length, 1);
  assert.ok(
    result.uncertainty.some(
      (item) => item.code === "artificial_structure_possible",
    ),
  );
});
