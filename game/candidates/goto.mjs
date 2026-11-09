// SPDX-License-Identifier: MIT
// Candidate navigation (see README): Pathfinder to a block with the current
// movements (walking only by default), checking every 0.5 s. Returns where it
// arrived; throws on no path, on no progress for `stallMs`, and with
// ctx.signal's reason once the exit is requested.
//
//   await goto(bot, ctx, [x, y, z])                        → { arrived: [x, y, z] }
//   await goto(bot, ctx, [x, y, z], { range: 2, stallMs: 30000 })
//   await goto(bot, ctx, [x, y, z], { checks: { eat: 'pause' } })   advanced: a checkpoint every 0.5 s
//
// Arrival is checked the way Pathfinder decides goal_reached (the feet cell
// or the one above meets the goal), not by a distance of its own.
import pathfinderPkg from 'mineflayer-pathfinder'
const { goals } = pathfinderPkg

export async function goto (bot, ctx, [x, y, z], { range = 1, checks = {}, stallMs = 20000 } = {}) {
  ctx.signal.throwIfAborted()
  const goal = new goals.GoalNear(x, y, z, range)
  let noPath = 0
  let lastPath = 'none'
  const onPath = r => {
    lastPath = r.status
    if (r.status === 'noPath') noPath++
  }
  bot.on('path_update', onPath)
  ctx.cleanup?.(() => { bot.off('path_update', onPath); bot.pathfinder.setGoal(null) })
  bot.pathfinder.setGoal(goal)
  let anchor = bot.entity.position.clone()
  let movedAt = Date.now()
  try {
    for (;;) {
      if (Object.keys(checks).length) await ctx.checkpoint(checks)
      ctx.signal.throwIfAborted()
      const feet = bot.entity.position.floored()
      if (goal.isEnd(feet) || goal.isEnd(feet.offset(0, 1, 0))) return { arrived: [feet.x, feet.y, feet.z] }
      if (noPath >= 3) throw new Error(`找不到去 ${x} ${y} ${z} 的路（当前寻路设置下），在 ${feet}`)
      if (bot.entity.position.distanceTo(anchor) > 1) { anchor = bot.entity.position.clone(); movedAt = Date.now() }
      if (Date.now() - movedAt > stallMs) throw new Error(`${stallMs / 1000} 秒没有前进，在 ${feet}，去 ${x} ${y} ${z}（寻路最后状态 ${lastPath}）`)
      if (!bot.pathfinder.goal) bot.pathfinder.setGoal(goal)
      await new Promise(resolve => setTimeout(resolve, 500))
    }
  } finally {
    bot.off('path_update', onPath)
    bot.pathfinder.setGoal(null)
  }
}
