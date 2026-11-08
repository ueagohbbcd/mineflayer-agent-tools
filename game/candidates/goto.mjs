// SPDX-License-Identifier: MIT
// Candidate navigation (see README): Pathfinder to a block, offering a
// checkpoint every 0.5 s. Throws on no path, on no progress for 20 s, or when
// Pathfinder stops without reaching the goal.
//
//   await goto(bot, ctx, [x, y, z], { range: 1, checks: { eat: 'pause' } })
import pathfinderPkg from 'mineflayer-pathfinder'
const { goals } = pathfinderPkg

export async function goto (bot, ctx, [x, y, z], { range = 1, checks = {}, stallMs = 20000 } = {}) {
  const goal = new goals.GoalNear(x, y, z, range)
  let noPath = 0
  const onPath = r => { if (r.status === 'noPath') noPath++ }
  bot.on('path_update', onPath)
  ctx.cleanup(() => { bot.off('path_update', onPath); bot.pathfinder.setGoal(null) })
  bot.pathfinder.setGoal(goal)
  let anchor = bot.entity.position.clone()
  let movedAt = Date.now()
  try {
    for (;;) {
      await ctx.checkpoint?.(checks)
      ctx.signal.throwIfAborted()
      const feet = bot.entity.position.floored()
      if (goal.isEnd(feet) || goal.isEnd(feet.offset(0, 1, 0))) return { arrived: [feet.x, feet.y, feet.z] }
      if (noPath >= 3) throw new Error(`找不到去 ${x} ${y} ${z} 的路（不挖不搭），在 ${feet}`)
      if (bot.entity.position.distanceTo(anchor) > 1) { anchor = bot.entity.position.clone(); movedAt = Date.now() }
      if (Date.now() - movedAt > stallMs) throw new Error(`${stallMs / 1000} 秒没有前进，在 ${feet}`)
      if (!bot.pathfinder.goal) bot.pathfinder.setGoal(goal)
      await new Promise(resolve => setTimeout(resolve, 500))
    }
  } finally {
    bot.off('path_update', onPath)
    bot.pathfinder.setGoal(null)
  }
}
