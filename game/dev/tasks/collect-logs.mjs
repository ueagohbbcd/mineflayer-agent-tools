// Collects N blocks of a kind with mineflayer-collectblock, using digging
// movements for this task only (the exit flow puts walking-only back).
//
//   node game.mjs run tasks/collect-logs.mjs [count=3] [block=oak_log]
import pathfinderPkg from 'mineflayer-pathfinder'
const { Movements } = pathfinderPkg

export default async function task (bot, ctx) {
  const count = Number(ctx.args[0] ?? 3)
  const name = ctx.args[1] ?? 'oak_log'
  const digging = new Movements(bot)
  bot.pathfinder.setMovements(digging)
  bot.collectBlock.movements = digging
  const blocks = bot.findBlocks({ matching: bot.registry.blocksByName[name].id, maxDistance: 32, count })
    .map(p => bot.blockAt(p))
  ctx.log(`找到 ${blocks.length} 个 ${name}`)
  if (!blocks.length) throw new Error(`32 格内没有 ${name}`)
  await bot.collectBlock.collect(blocks)
  if (ctx.signal.aborted) return
  const have = bot.inventory.items().filter(i => i.name === name).reduce((n, i) => n + i.count, 0)
  return { collected: blocks.length, have, canDigDuringTask: bot.pathfinder.movements.canDig }
}
