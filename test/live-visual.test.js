"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict");
const fs = require("node:fs/promises"),
  path = require("node:path"),
  os = require("node:os");
const live = require("../live"),
  { Vec3 } = require("vec3");
const registry = require("prismarine-registry")("1.21.1"),
  Chunk = require("prismarine-chunk")("1.21.1");
const bounds = (x = 0, y = 0, z = 0) => ({
  min: { x: 0, y: 0, z: 0 },
  max: { x, y, z },
});
const pixel = (r, x, y) => [
  ...r.rgba.subarray(
    (y * r.metadata.width + x) * 4,
    (y * r.metadata.width + x) * 4 + 3,
  ),
];
const surface = (overrides = {}) => ({
  bounds: bounds(),
  version: "1.21.1",
  columns: [
    {
      x: 0,
      z: 0,
      known: 1,
      unknownAbove: false,
      top: {
        x: 0,
        y: 0,
        z: 0,
        name: "stone",
        stateId: registry.blocksByName.stone.defaultState,
      },
    },
  ],
  ...overrides,
});
async function atlas(t, { faceRotation = 0, variantY = 0 } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "world-live-atlas-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "textures"));
  await fs.mkdir(path.join(root, "blocksStates"));
  // Self-authored synthetic pixels only; no Minecraft assets are in the test fixture.
  const rgba = Buffer.from([
    255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 0, 255,
  ]);
  await fs.writeFile(
    path.join(root, "textures/1.21.1.png"),
    live.encodePNG(2, 2, rgba),
  );
  const tile = { u: 0, v: 0, su: 1, sv: 1 };
  const model = {
    elements: [
      {
        from: [0, 0, 0],
        to: [16, 16, 16],
        faces: { up: { rotation: faceRotation, texture: tile } },
      },
    ],
  };
  const directional = {
    elements: [
      {
        from: [0, 0, 0],
        to: [16, 16, 16],
        faces: {
          north: { texture: { u: 0, v: 0, su: 0.5, sv: 0.5 } },
          south: { texture: { u: 0.5, v: 0.5, su: 0.5, sv: 0.5 } },
        },
      },
    ],
  };
  await fs.writeFile(
    path.join(root, "blocksStates/1.21.1.json"),
    JSON.stringify({
      stone: { variants: { "": { model, y: variantY } } },
      andesite: {
        variants: {
          "": {
            model: {
              elements: [
                {
                  ...model.elements[0],
                  faces: { up: { texture: { u: 0, v: 1, su: 1, sv: -1 } } },
                },
              ],
            },
          },
        },
      },
      granite: {
        variants: {
          "": {
            model: {
              elements: [
                {
                  ...model.elements[0],
                  faces: { up: { rotation: 90, texture: tile } },
                },
              ],
            },
          },
        },
      },
      observer: {
        variants: {
          "facing=down,powered=false": { x: 90, model: directional },
          "facing=up,powered=false": { x: 270, model: directional },
        },
      },
    }),
  );
  return root;
}
test("CJS, ESM and existing visual namespace expose the same functions", async () => {
  assert.equal(require("..").visual.live.renderMinimap, live.renderMinimap);
  assert.equal((await import("../live.mjs")).renderMinimap, live.renderMinimap);
  assert.equal(typeof require("..").visual.exportSurface, "function");
  assert.equal(live.renderOpeningComposite, undefined);
});
test("scans distinguish known air, missing cells and unknown above a surface", () => {
  const bot = {
    blockAt: (p) =>
      p.x === 0
        ? { name: "air" }
        : p.x === 1 && p.y === 0
          ? { name: "stone" }
          : null,
  };
  const s = live.surfaceSnapshotFromBot(bot, bounds(2, 1));
  assert.equal(s.columns[0].known, 2);
  assert.equal(s.columns[1].unknownAbove, true);
  assert.equal(s.columns[2].known, 0);
  assert.equal(s.sampledAt, null);
  assert.ok(s.acquiredAt);
  const r = live.renderSurfaceMinimap(s, { width: 48, height: 16 });
  assert.deepEqual(pixel(r, 5, 5), live.AIR_COLOR);
  assert.deepEqual(pixel(r, 40, 5), live.UNKNOWN_COLOR);
  assert.equal(r.metadata.knownVoxels, 3);
  assert.equal(r.metadata.columns.partialAboveSurface, 1);
  assert.equal(
    live.snapshotFromBot(bot, { bounds: bounds(2, 1) }).blocks.length,
    3,
  );
});
test("native Mineflayer-style readers receive Vec3 and native getColumns supports negative coordinates", () => {
  const chunk = new Chunk({ minY: -16, worldHeight: 32 });
  chunk.setBlockStateId(
    new Vec3(15, -2, 0),
    registry.blocksByName.stone.defaultState,
  );
  let calls = 0;
  const bot = {
    version: "1.21.1",
    registry,
    game: { minY: -16, height: 32 },
    entity: { position: new Vec3(-0.5, 0, 0.5) },
    world: { getColumns: () => [{ chunkX: "-1", chunkZ: "0", column: chunk }] },
    blockAt(p) {
      calls++;
      assert.equal(typeof p.floored, "function");
      return Math.floor(p.x / 16) === -1
        ? chunk.getBlock(new Vec3(p.x & 15, p.y, p.z & 15))
        : null;
    },
  };
  assert.deepEqual(live.observationViewBounds(bot).overview.bounds, {
    min: { x: -16, y: -16, z: 0 },
    max: { x: -1, y: 15, z: 15 },
  });
  const s = live.surfaceSnapshotFromBot(bot, {
    min: { x: -1, y: -16, z: 0 },
    max: { x: 0, y: 15, z: 0 },
  });
  assert.equal(s.columns[0].known, 32);
  assert.equal(s.columns[0].top.y, -2);
  assert.equal(s.columns[1].known, 0);
  assert.equal(calls, 1);
  assert.equal(
    live.snapshotFromBot(bot, {
      bounds: { min: { x: -1, y: -2, z: 0 }, max: { x: -1, y: -2, z: 0 } },
    }).blocks[0].name,
    "stone",
  );
});
test("large full-column overview avoids a full voxel allocation and obeys budgets", () => {
  let calls = 0;
  const bot = {
    hasColumnMirror: true,
    columns: new Map(),
    blockAt: () => {
      calls++;
      return { name: "stone" };
    },
  };
  for (let x = 0; x < 8; x++)
    for (let z = 0; z < 8; z++)
      bot.columns.set(`${x},${z}`, {
        chunk: { minY: -64, worldHeight: 384, getBlockStateId: () => 1 },
      });
  const box = { min: { x: 0, y: -64, z: 0 }, max: { x: 127, y: 319, z: 127 } };
  const r = live.renderSurfaceMinimap(live.surfaceSnapshotFromBot(bot, box), {
    width: 128,
    height: 128,
  });
  assert.equal(calls, 16384);
  assert.equal(r.metadata.knownFraction, 1);
  assert.equal(r.metadata.totalVoxels, 128 * 128 * 384);
  assert.throws(
    () => live.surfaceSnapshotFromBot(bot, box, { maxColumns: 10 }),
    /maxColumns/,
  );
  assert.throws(
    () =>
      live.surfaceSnapshotFromBot({ blockAt: () => null }, bounds(0, 2), {
        maxSamples: 1,
      }),
    /sample budget/,
  );
  assert.throws(
    () => live.snapshotFromBot(bot, { bounds: bounds(), maxVoxels: NaN }),
    /maxVoxels/,
  );
});
test("local bounds remain at the player after teleport outside loaded overview", () => {
  const bot = {
    entity: { position: new Vec3(100.5, 14, -50.25) },
    game: { minY: 0, height: 16 },
    columns: new Map([["0,0", {}]]),
  };
  const s = live.observationViewBounds(bot, { viewRadius: 2 });
  assert.equal(s.overview.bounds.max.x, 15);
  assert.deepEqual(s.local.bounds, {
    min: { x: 98, y: 13, z: -53 },
    max: { x: 102, y: 15, z: -49 },
  });
  assert.equal(s.local.requestedBounds.max.y, 16);
});
test("explored history retains age, epoch, observation times and stale overlay", () => {
  const block = { name: "stone", position: new Vec3(0, 0, 0) };
  const bot = {
    knownBlocks: new Map([
      ["0,0,0", { block, observedAt: 1000, epoch: "old" }],
    ]),
    blockAt: () => ({ known: false }),
  };
  const s = live.snapshotFromExplored(bot, { bounds: bounds(), now: 3000 });
  assert.equal(s.blocks[0].ageMs, 2000);
  assert.equal(s.blocks[0].stale, true);
  assert.equal(s.blocks[0].epoch, "old");
  const r = live.renderMinimap(s, { width: 16, height: 16 });
  assert.equal(r.metadata.staleVoxels, 1);
  assert.deepEqual(r.metadata.observedAtRange, [1000, 1000]);
  assert.deepEqual(pixel(r, 0, 1), [211, 151, 51]);
  assert.equal(
    live.snapshotFromExplored(bot, {
      bounds: bounds(),
      now: 3000,
      maxAgeMs: 1000,
    }).blocks.length,
    0,
  );
});
test("PNG atlas decoder round trips RGBA and rejects malformed/oversized input", () => {
  const bytes = Buffer.from([1, 2, 3, 4, 6, 7, 8, 255]),
    png = live.encodePNG(2, 1, bytes);
  assert.deepEqual(live.decodeTextureAtlas(png).data, bytes);
  assert.throws(
    () => live.decodeTextureAtlas(Buffer.from("broken")),
    /Invalid/,
  );
  png.writeUInt32BE(20000000, 16);
  assert.throws(() => live.decodeTextureAtlas(png), /8-bit RGBA/);
});
test("CPU textures preserve orientation, stale stripes and unknown hatching", async (t) => {
  const assetsPath = await atlas(t),
    r = live.renderTexturedSurface(surface(), {
      assetsPath,
      width: 16,
      height: 16,
    });
  assert.equal(r.metadata.renderer.fallback, false);
  assert.deepEqual(pixel(r, 13, 2), [0, 255, 0]);
  assert.deepEqual(pixel(r, 2, 13), [0, 0, 255]);
  const rotated = live.renderTexturedSurface(surface(), {
    assetsPath,
    width: 16,
    height: 16,
    horizontalAxis: "z",
  });
  assert.deepEqual(pixel(rotated, 13, 2), [0, 0, 255]);
  const s = surface();
  s.columns[0].unknownAbove = true;
  s.columns[0].top.stale = true;
  const partial = live.renderTexturedSurface(s, {
    assetsPath,
    width: 16,
    height: 16,
  });
  assert.deepEqual(pixel(partial, 0, 0), live.UNKNOWN_COLOR);
  assert.deepEqual(pixel(partial, 1, 2), [211, 151, 51]);
  assert.equal(partial.metadata.staleVoxels, 1);
});
test("directional variants use Viewer rotation signs when selecting upward faces", async (t) => {
  const assetsPath = await atlas(t),
    s = surface();
  s.columns[0].top = {
    x: 0,
    y: 0,
    z: 0,
    name: "observer",
    properties: { facing: "down", powered: false },
  };
  assert.deepEqual(
    pixel(
      live.renderTexturedSurface(s, { assetsPath, width: 16, height: 16 }),
      8,
      8,
    ),
    [255, 255, 0],
  );
  s.columns[0].top.properties.facing = "up";
  assert.deepEqual(
    pixel(
      live.renderTexturedSurface(s, { assetsPath, width: 16, height: 16 }),
      8,
      8,
    ),
    [255, 0, 0],
  );
});
test("missing assets and unsupported block models have explicit, separate fallbacks", async (t) => {
  const s = surface(),
    assetsPath = await atlas(t);
  const missing = live.renderTexturedSurface(s, {
    assetsPath: path.join(assetsPath, "missing"),
    width: 8,
    height: 8,
  });
  assert.equal(missing.metadata.renderer.fallback, true);
  assert.equal(missing.metadata.renderer.actual, "schematic-surface");
  assert.match(missing.metadata.renderer.reason, /ENOENT/);
  s.columns[0].top.name = "chest";
  s.columns[0].top.stateId = registry.blocksByName.chest.defaultState;
  const special = live.renderTexturedSurface(s, {
    assetsPath,
    width: 8,
    height: 8,
  });
  assert.equal(special.metadata.renderer.schematicFallbackColumns, 1);
  assert.equal(special.metadata.renderer.texturedColumns, 0);
  assert.match(
    special.metadata.renderer.specialBlockFallbacks[0].reason,
    /multipart or unavailable/,
  );
});
test("rotated non-square surface puts columns on the selected axis", async (t) => {
  const assetsPath = await atlas(t),
    s = surface({ bounds: bounds(1), columns: [surface().columns[0]] });
  const r = live.renderTexturedSurface(s, {
    assetsPath,
    width: 16,
    height: 32,
    horizontalAxis: "z",
  });
  assert.deepEqual(pixel(r, 13, 2), [0, 0, 255]);
  assert.deepEqual(pixel(r, 2, 28), live.UNKNOWN_COLOR);
});
test("saveRender produces a bare PNG with png.json sidecar and supports refresh overwrite", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "world-live-save-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const r = live.renderSurfaceMinimap(surface(), { width: 16, height: 8 }),
    output = await live.saveRender(r, path.join(root, "map"));
  assert.equal(output.metadataPath, output.imagePath + ".json");
  assert.deepEqual(await fs.readFile(output.imagePath), r.png);
  assert.equal(
    JSON.parse(await fs.readFile(output.metadataPath)).presentation,
    false,
  );
  await live.saveRender(
    live.renderSurfaceMinimap(surface(), { width: 8, height: 8 }),
    path.join(root, "map"),
  );
  assert.equal((await fs.readFile(output.imagePath)).readUInt32BE(16), 8);
});
test("invalid images and contradictory compact coverage cannot silently become known air", () => {
  assert.throws(
    () => live.renderSurfaceMinimap(surface(), { width: 8192, height: 8192 }),
    RangeError,
  );
  assert.throws(
    () => live.renderOblique({ bounds: bounds(1000, 1000, 1000), blocks: [] }),
    RangeError,
  );
  const s = surface();
  s.columns[0].known = 0;
  assert.throws(() => live.renderSurfaceMinimap(s), /invalid surface block/);
  for (const unknownAbove of [undefined, false]) {
    const r = live.renderSurfaceMinimap(
      surface({
        bounds: bounds(0, 1),
        columns: [{ x: 0, z: 0, known: 1, top: null, unknownAbove }],
      }),
      { width: 1, height: 1 },
    );
    assert.equal(r.metadata.columns.knownClear, 0);
    assert.deepEqual(pixel(r, 0, 0), live.UNKNOWN_COLOR);
  }
});

test("face rotation rotates UV in the same direction as Viewer", async (t) => {
  const assetsPath = await atlas(t),
    s = surface();
  s.columns[0].top.name = "granite";
  s.columns[0].top.stateId = registry.blocksByName.granite.defaultState;
  const r = live.renderTexturedSurface(s, {
    assetsPath,
    width: 16,
    height: 16,
  });
  assert.deepEqual(pixel(r, 4, 4), [0, 0, 255]);
});
test("native chunk out-of-height air is never accepted as known volume data", () => {
  const chunk = { minY: 80, worldHeight: 32 };
  const s = live.snapshotFromBot(
    { world: { getColumn: () => chunk }, blockAt: () => ({ name: "air" }) },
    { bounds: { min: { x: 0, y: 79, z: 0 }, max: { x: 0, y: 80, z: 0 } } },
  );
  assert.deepEqual(
    s.blocks.map((b) => b.y),
    [80],
  );
});
test("explored block with changed current state or epoch is historical, not fresh", () => {
  const block = {
    name: "diamond_block",
    stateId: 5,
    position: new Vec3(0, 0, 0),
  };
  const bot = {
    epoch: "new",
    knownBlocks: new Map([
      ["0,0,0", { block, observedAt: 1000, epoch: "old" }],
    ]),
    blockAt: () => ({ name: "stone", stateId: 1 }),
  };
  assert.equal(
    live.snapshotFromExplored(bot, { bounds: bounds(), now: 2000 }).blocks[0]
      .stale,
    true,
  );
});

test("mirrored atlas extent uses the complete reversed tile without a boundary seam", async (t) => {
  const assetsPath = await atlas(t),
    s = surface();
  s.columns[0].top.name = "andesite";
  s.columns[0].top.stateId = registry.blocksByName.andesite.defaultState;
  const r = live.renderTexturedSurface(s, { assetsPath, width: 2, height: 2 });
  assert.deepEqual(pixel(r, 0, 0), [0, 0, 255]);
  assert.deepEqual(pixel(r, 0, 1), [255, 0, 0]);
  assert.deepEqual(pixel(r, 1, 0), [255, 255, 0]);
  assert.deepEqual(pixel(r, 1, 1), [0, 255, 0]);
});

test("pixel-center sampling preserves all four pixels across face and variant rotations", async (t) => {
  const red = [255, 0, 0],
    green = [0, 255, 0],
    blue = [0, 0, 255],
    yellow = [255, 255, 0];
  const expected = {
    90: [blue, red, yellow, green],
    180: [yellow, blue, green, red],
    270: [green, yellow, red, blue],
  };
  for (const field of ["faceRotation", "variantY"])
    for (const rotation of [90, 180, 270]) {
      const assetsPath = await atlas(t, { [field]: rotation });
      const r = live.renderTexturedSurface(surface(), {
        assetsPath,
        width: 2,
        height: 2,
      });
      assert.deepEqual(
        [
          [0, 0],
          [1, 0],
          [0, 1],
          [1, 1],
        ].map(([x, y]) => pixel(r, x, y)),
        expected[rotation],
        `${field}=${rotation}`,
      );
    }
});

test("callers can raise surface budgets without a hidden second ceiling", () => {
  const box = { min: { x: 0, y: 0, z: 0 }, max: { x: 262144, y: 0, z: 0 } };
  const bot = {
    hasColumnMirror: true,
    columns: new Map(),
    blockAt: () => assert.fail("unloaded mirror read"),
  };
  const s = live.surfaceSnapshotFromBot(bot, box, { maxColumns: 262145 });
  const r = live.renderSurfaceMinimap(s, { width: 1, height: 1 });
  assert.equal(r.metadata.columns.total, 262145);
  assert.equal(r.metadata.knownVoxels, 0);
});
