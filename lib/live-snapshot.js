// SPDX-License-Identifier: MIT
// Generic visual primitives contributed from the craft-arena integration.
const { Vec3 } = require("vec3");
const AIR = new Set(["air", "cave_air", "void_air"]);
const point = (p) => Object.fromEntries(["x", "y", "z"].map((a) => [a, p[a]]));
const floor = (p) =>
  Object.fromEntries(["x", "y", "z"].map((a) => [a, Math.floor(p[a])]));
function validBounds(bounds) {
  if (
    !bounds ||
    !["min", "max"].every((end) =>
      ["x", "y", "z"].every((a) => Number.isSafeInteger(bounds[end]?.[a])),
    ) ||
    ["x", "y", "z"].some((a) => bounds.min[a] > bounds.max[a])
  )
    throw new TypeError("bounds need inclusive integer min/max x,y,z");
  const volume = ["x", "y", "z"].reduce(
    (v, a) => v * (bounds.max[a] - bounds.min[a] + 1),
    1,
  );
  if (!Number.isSafeInteger(volume))
    throw new RangeError("bounds volume must be a safe integer");
  return { min: point(bounds.min), max: point(bounds.max) };
}
function radiusValue(value) {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new TypeError("viewRadius must be a nonnegative integer");
  return value;
}
function worldHeight(bot, p) {
  const minY = bot.game?.minY,
    height = bot.game?.height;
  return Number.isSafeInteger(minY) &&
    Number.isSafeInteger(height) &&
    height > 0
    ? { min: minY, max: minY + height - 1, known: true }
    : { min: p.y - 16, max: p.y + 32, known: false };
}
/** Overview and current-layer bounds have independent purposes, including after a teleport. */
function observationViewBounds(bot, options = {}) {
  const position = bot.entity?.position;
  if (!position || !["x", "y", "z"].every((a) => Number.isFinite(position[a])))
    throw new Error("Observation views require a known player position");
  const p = floor(position),
    vertical = worldHeight(bot, p);
  const nativeColumns =
    typeof bot.world?.getColumns === "function" ? bot.world.getColumns() : [];
  const columnKeys =
    bot.columns?.keys?.() ??
    nativeColumns.map(({ chunkX, chunkZ }) => `${chunkX},${chunkZ}`);
  const columns = [...columnKeys]
    .map((id) => String(id).split(",").map(Number))
    .filter((v) => v.length === 2 && v.every(Number.isSafeInteger));
  const known = [...(bot.blocks?.values() ?? [])]
    .map((b) => b.position)
    .filter((p) => p && ["x", "z"].every((a) => Number.isFinite(p[a])));
  let overview, mode;
  if (options.overviewBounds ?? options.publicMapBounds) {
    overview = validBounds(options.overviewBounds ?? options.publicMapBounds);
    mode = options.overviewBounds
      ? "explicit overview bounds"
      : "public map bounds";
  } else if (columns.length) {
    overview = {
      min: {
        x: Math.min(...columns.map(([x]) => x)) * 16,
        y: vertical.min,
        z: Math.min(...columns.map(([, z]) => z)) * 16,
      },
      max: {
        x: Math.max(...columns.map(([x]) => x)) * 16 + 15,
        y: vertical.max,
        z: Math.max(...columns.map(([, z]) => z)) * 16 + 15,
      },
    };
    mode = "full loaded-column extent";
  } else if (known.length) {
    overview = {
      min: {
        x: Math.floor(Math.min(...known.map((p) => p.x))),
        y: vertical.min,
        z: Math.floor(Math.min(...known.map((p) => p.z))),
      },
      max: {
        x: Math.floor(Math.max(...known.map((p) => p.x))),
        y: vertical.max,
        z: Math.floor(Math.max(...known.map((p) => p.z))),
      },
    };
    mode = "observed block extent; no loaded-column map available";
  } else {
    overview = {
      min: { x: p.x, y: vertical.min, z: p.z },
      max: { x: p.x, y: vertical.max, z: p.z },
    };
    mode = "player column only; no loaded map extent available";
  }
  const radius = radiusValue(options.viewRadius ?? 12);
  function crop(below, above) {
    const requested = {
      min: { x: p.x - radius, y: p.y - below, z: p.z - radius },
      max: { x: p.x + radius, y: p.y + above, z: p.z + radius },
    };
    const bounds = structuredClone(requested);
    // Only valid dimension height clips Y. Loaded X/Z extents never clip a local crop.
    if (
      vertical.known &&
      requested.min.y <= vertical.max &&
      requested.max.y >= vertical.min
    ) {
      bounds.min.y = Math.max(bounds.min.y, vertical.min);
      bounds.max.y = Math.min(bounds.max.y, vertical.max);
    }
    return { bounds, requested };
  }
  const local = crop(1, 2),
    structure = crop(8, 16);
  return {
    overview: {
      bounds: validBounds(overview),
      mode,
      dimensionHeightKnown: vertical.known,
      loadedColumns: columns.length,
    },
    local: {
      bounds: options.localBounds
        ? validBounds(options.localBounds)
        : local.bounds,
      requestedBounds: options.localBounds
        ? validBounds(options.localBounds)
        : local.requested,
      mode: options.localBounds
        ? "explicit local slice"
        : "current layer: feet Y - 1 through Y + 2",
    },
    "3d": {
      bounds: options.structureBounds
        ? validBounds(options.structureBounds)
        : structure.bounds,
      requestedBounds: options.structureBounds
        ? validBounds(options.structureBounds)
        : structure.requested,
      mode: options.structureBounds
        ? "explicit structure bounds"
        : "local structure crop",
    },
  };
}
/** Full-height surface coverage, compact in X/Z rather than allocating a full 3D volume. */
function surfaceSnapshotFromBot(
  bot,
  bounds,
  { maxColumns = 262144, maxSamples = 134217728 } = {},
) {
  bounds = validBounds(bounds);
  const area =
    (bounds.max.x - bounds.min.x + 1) * (bounds.max.z - bounds.min.z + 1);
  if (![maxColumns, maxSamples].every((n) => Number.isSafeInteger(n) && n > 0))
    throw new TypeError("surface budgets must be positive safe integers");
  if (area > maxColumns || area > 262144)
    throw new RangeError(
      "surface acquisition exceeds maxColumns (hard limit 262144)",
    );
  let samples = 0;
  const nativeColumns =
    typeof bot.world?.getColumns === "function"
      ? new Map(
          bot.world
            .getColumns()
            .map(({ chunkX, chunkZ, column }) => [
              `${chunkX},${chunkZ}`,
              { chunk: column },
            ]),
        )
      : null;
  const loaded = bot.columns ?? nativeColumns;
  const acquiredAt = new Date().toISOString();
  const columns = [];
  const height = bounds.max.y - bounds.min.y + 1;
  for (let z = bounds.min.z; z <= bounds.max.z; z++)
    for (let x = bounds.min.x; x <= bounds.max.x; x++) {
      let known = 0,
        unknownAbove = false,
        top = null;
      const entry = loaded?.get(`${Math.floor(x / 16)},${Math.floor(z / 16)}`);
      const chunk = entry?.chunk;
      const chunkMin = chunk?.minY ?? bot.game?.minY;
      const chunkHeight = chunk?.worldHeight ?? bot.game?.height;
      // Full transmitted chunks establish all cells within their declared height, including air.
      const fullColumn =
        typeof chunk?.getBlockStateId === "function" &&
        Number.isSafeInteger(chunkMin) &&
        Number.isSafeInteger(chunkHeight) &&
        chunkHeight > 0;
      if ((bot.hasColumnMirror || nativeColumns) && !entry) {
        columns.push({ x, z, known: 0, unknownAbove: true, top: null });
        continue;
      }
      if (fullColumn) {
        known = Math.max(
          0,
          Math.min(bounds.max.y, chunkMin + chunkHeight - 1) -
            Math.max(bounds.min.y, chunkMin) +
            1,
        );
        unknownAbove = bounds.max.y >= chunkMin + chunkHeight;
      }
      for (let y = bounds.max.y; y >= bounds.min.y; y--) {
        if (++samples > Math.min(maxSamples, 134217728))
          throw new RangeError(
            "surface sample budget exceeded; choose a smaller area or Y range",
          );
        if (fullColumn && (y < chunkMin || y >= chunkMin + chunkHeight))
          continue;
        // The SDK's full chunk mirrors expose raw state IDs. Skip known air without
        // constructing millions of Prismarine block objects for a full-height overview.
        if (
          fullColumn &&
          typeof chunk.getBlockStateId === "function" &&
          bot.registry?.blocksByStateId
        ) {
          const stateId = chunk.getBlockStateId({ x: x & 15, y, z: z & 15 });
          const definition = bot.registry.blocksByStateId[stateId];
          if (definition && AIR.has(definition.name)) continue;
        }
        const block = bot.blockAt(new Vec3(x, y, z));
        if (!block || block.known === false) {
          if (!top) unknownAbove = true;
          // A partial adapter must not acquire false known-air coverage from a claimed column.
          if (fullColumn) known--;
          continue;
        }
        if (!fullColumn) known++;
        if (!top && !AIR.has(block.name.replace(/^minecraft:/, ""))) {
          top = {
            x,
            y,
            z,
            name: block.name,
            stateId: block.stateId,
            properties:
              typeof block.getProperties === "function"
                ? block.getProperties()
                : undefined,
          };
          if (fullColumn) break;
        }
      }
      if (!top && known < height) unknownAbove = true;
      columns.push({ x, z, known, unknownAbove, top });
    }
  return {
    bounds,
    columns,
    version: bot.version,
    dimension: bot.game?.dimension ?? null,
    acquiredAt,
    samples,
    unknownIsAir: false,
    epoch: bot.epoch ?? null,
    sequence: bot.sequence ?? null,
    sampledAt: bot.sampledAt ?? null,
    source: "current bot mirror surface scan; absent cells remain unknown",
  };
}

module.exports = {
  observationViewBounds,
  surfaceSnapshotFromBot,
  validBounds,
  radiusValue,
};
