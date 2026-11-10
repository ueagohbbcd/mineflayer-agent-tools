// SPDX-License-Identifier: MIT
// Explore observer. Every second it scans the open space around your head,
// up to 6 blocks, through transparent and non-solid blocks (glass, leaves,
// water, ladders, slabs), possibly around corners; it is not a line-of-sight
// or walkability test. It records (records/explore.jsonl) the blocks it has
// not seen before and the signs in range when they change. Never notifies.
//
// `node report.mjs explore` sums them up: block types and how many of each,
// where the rare ones are, the box the scans covered, and the signs' text.
import { Vec3 } from "vec3";
import {
  observedHeadCell,
  sampleNearbyConnectedBlocks,
} from "../observation/nearby-connected-blocks.mjs";
import { clock, createPendingWrites } from "./support.mjs";

const point = (p) => [p.x, p.y, p.z];
const keyOf = (p) => `${p.x},${p.y},${p.z}`;

/** Watch one bot; returns { close(), flush(), scan() }. */
export function startExplore({
  bot,
  log,
  sampleMs = 1000,
  radius = 6,
  maxReads = 4096,
  // Positions remembered as seen; past this the memory starts again.
  maxSeen = 500_000,
  scan = sampleNearbyConnectedBlocks,
}) {
  const writes = createPendingWrites((error) =>
    console.error(`explore: log failed: ${error.message}`),
  );
  const write = (data, options) => writes.track(() => log.post(data, options));
  const seen = new Map(); // "dimension x,y,z" -> block name
  let signs = "[]";
  function once() {
    const head = observedHeadCell(bot.entity);
    if (!head.position || typeof bot.blockAt !== "function") return;
    const dimension = typeof bot.game?.dimension === "string" ? bot.game.dimension : null;
    let result;
    try {
      result = scan({
        blockAt: (p) => bot.blockAt(new Vec3(p.x, p.y, p.z)),
        origin: head.position,
        radius,
        maxReads,
      });
    } catch {
      return;
    }
    if (seen.size > maxSeen) seen.clear();
    const counts = {};
    const positions = {};
    for (const { name, position } of result.blocks) {
      const key = `${dimension} ${keyOf(position)}`;
      if (seen.get(key) === name) continue;
      seen.set(key, name);
      counts[name] = (counts[name] ?? 0) + 1;
      (positions[name] ??= []).push(point(position));
    }
    if (Object.keys(counts).length) {
      // Positions only for types that are few here; the common ones are counts.
      for (const [name, list] of Object.entries(positions))
        if (list.length > 16) delete positions[name];
        else positions[name] = list.slice(-3);
      const box = result.knownBounds && [point(result.knownBounds.min), point(result.knownBounds.max)];
      write({ dimension, counts, positions, ...(box ? { box } : {}) }, { type: "blocks" });
    }
    const now = JSON.stringify(
      (result.signs ?? []).map(({ position, front, back }) => ({
        at: point(position),
        front: front?.known ? front.text : null,
        back: back?.known ? back.text : null,
      })),
    );
    if (now !== signs) {
      signs = now;
      const list = JSON.parse(now);
      if (list.length) write({ dimension, signs: list }, { type: "signs", key: `signs:${list.map((s) => s.at.join(",")).join(";")}` });
    }
  }
  const timer = setInterval(once, sampleMs);
  return {
    scan: once,
    flush: writes.flush,
    close: () => clearInterval(timer),
  };
}

/** `node report.mjs explore` (game/bin/report.mjs): explore entries as a sum, not a list. */
export function summarize(entries) {
  const lines = [];
  const blocks = entries.filter((entry) => entry.type === "blocks");
  const byDimension = new Map();
  for (const { data } of blocks) {
    const d = data.dimension ?? "unknown";
    if (!byDimension.has(d)) byDimension.set(d, { counts: {}, positions: {}, min: null, max: null });
    const sum = byDimension.get(d);
    for (const [name, count] of Object.entries(data.counts ?? {})) sum.counts[name] = (sum.counts[name] ?? 0) + count;
    for (const [name, list] of Object.entries(data.positions ?? {}))
      sum.positions[name] = [...(sum.positions[name] ?? []), ...list].slice(-3);
    if (data.box) {
      sum.min = sum.min ? sum.min.map((v, i) => Math.min(v, data.box[0][i])) : [...data.box[0]];
      sum.max = sum.max ? sum.max.map((v, i) => Math.max(v, data.box[1][i])) : [...data.box[1]];
    }
  }
  if (blocks.length)
    lines.push(`blocks not seen before, ${blocks.length} scans from ${clock(blocks[0].at)} to ${clock(blocks.at(-1).at)}:`);
  for (const [dimension, sum] of byDimension) {
    if (sum.min)
      lines.push(
        `  ${dimension}: scanned x ${sum.min[0]}..${sum.max[0]}, y ${sum.min[1]}..${sum.max[1]}, z ${sum.min[2]}..${sum.max[2]}`,
      );
    const names = Object.entries(sum.counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    lines.push(
      `  ${names
        .map(([name, count]) =>
          count <= 6 && sum.positions[name]
            ? `${name} ${count} (${sum.positions[name].map((p) => p.join(",")).join(" ")})`
            : `${name} ${count}`,
        )
        .join(", ")}`,
    );
  }
  // The newest reading of each set of signs.
  const newest = new Map();
  for (const entry of entries) if (entry.type === "signs") newest.set(entry.key, entry);
  for (const { at, data } of newest.values())
    for (const sign of data.signs)
      lines.push(
        `sign ${sign.at.join(",")} (${clock(at)}): ${JSON.stringify(sign.front ?? "?")}${sign.back ? ` / back ${JSON.stringify(sign.back)}` : ""}`,
      );
  return lines;
}
