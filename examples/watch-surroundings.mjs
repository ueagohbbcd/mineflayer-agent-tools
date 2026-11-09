/**
 * Watch loaded blocks near the character until one of a kind shows up, then
 * end with what was found:
 *
 *   node game.mjs run <toolkit>/examples/watch-surroundings.mjs [block=chest] [seconds=600]
 *
 * It is submitted as work, so it replaces the running work; it only reads
 * the world while it waits. Start it in the background: its end is what
 * tells you something was found.
 */
import { setTimeout as sleep } from "node:timers/promises";
import { Vec3 } from "vec3";
import { sampleNearbyConnectedBlocks } from "../game/observation/nearby-connected-blocks.mjs";

export default async function watchSurroundings(bot, { args = [], signal }) {
  const target = args[0] ?? "chest";
  const seconds = Number(args[1] ?? 600);
  if (!Number.isFinite(seconds) || seconds <= 0)
    throw new Error("Watch duration must be positive seconds");
  const until = Date.now() + seconds * 1000;
  while (Date.now() < until) {
    signal?.throwIfAborted();
    const origin = bot.entity.position.floored();
    const scan = sampleNearbyConnectedBlocks({
      origin,
      radius: 6,
      blockAt: (p) => bot.blockAt(new Vec3(p.x, p.y, p.z)),
    });
    const blocks = scan.blocks.filter(({ name }) => name === target);
    if (blocks.length) {
      return {
        status: "found",
        target,
        dimension: bot.game?.dimension,
        blocks,
      };
    }
    await sleep(1000, undefined, { signal });
  }
  return { status: "not_found", target, seconds };
}
