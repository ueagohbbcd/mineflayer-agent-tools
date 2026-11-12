// Asks craftAndCount for N sticks without a crafting table, to see a request
// the inventory cannot fully meet end in a "wanted N, got M" error.
//
//   node game.mjs run tasks/craft-sticks.mjs [count=8]
import { craftAndCount } from 'mineflayer-world-memory/game/experimental/craft-and-count.mjs'

export default async function task (bot, ctx) {
  const count = Number(ctx.args[0] ?? 8)
  return craftAndCount(bot, ctx, 'stick', count)
}
