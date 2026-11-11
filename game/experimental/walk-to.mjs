// SPDX-License-Identifier: MIT
// Experimental navigation (see README): Pathfinder to a block with the current
// movements (walking only by default), checking every 0.5 s. Returns where it
// arrived; throws on no path, on no progress for `stallMs`, and with
// ctx.signal's reason once the exit is requested.
//
//   await walkTo(bot, ctx, [x, y, z])                        → { arrived: [x, y, z] }
//   await walkTo(bot, ctx, [x, y, z], { range: 2, stallMs: 30000 })
//   await walkTo(bot, ctx, [x, y, z], { checks: { eatWhenHungry: 'restart' } })   advanced: a safepoint every 0.5 s
//
// Arrival is checked the way Pathfinder decides goal_reached (the feet cell
// or the one above meets the goal), not by a distance of its own.
import pathfinderPkg from 'mineflayer-pathfinder'
const { goals } = pathfinderPkg

// Does: walks to [x, y, z] within `range` with the current movements; returns
//   { arrived }, throws after 3 noPath, `stallMs` without progress, or abort.
// Checked: 2026-11-08: 15 blocks in 4.5 s; stall error after 20 s inside a
//   block; cancel stops it (1 run each). 2026-11-10: 16 blocks in 3.6 s, patrols.
// Limits: walking only by default, so it cannot leave a pit the bot dug
//   (noPath, playtest 2026-11-10, 2/3 agents).
export async function walkTo (bot, ctx, [x, y, z], { range = 1, checks = {}, stallMs = 20000 } = {}) {
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
      if (Object.keys(checks).length) await ctx.safepoint(checks)
      ctx.signal.throwIfAborted()
      const feet = bot.entity.position.floored()
      if (goal.isEnd(feet) || goal.isEnd(feet.offset(0, 1, 0))) return { arrived: [feet.x, feet.y, feet.z] }
      if (noPath >= 3) throw new Error(`no path to ${x} ${y} ${z} with the current movements, from ${feet}`)
      if (bot.entity.position.distanceTo(anchor) > 1) { anchor = bot.entity.position.clone(); movedAt = Date.now() }
      if (Date.now() - movedAt > stallMs) throw new Error(`no progress for ${stallMs / 1000} s at ${feet} on the way to ${x} ${y} ${z} (last path status: ${lastPath})`)
      if (!bot.pathfinder.goal) bot.pathfinder.setGoal(goal)
      await new Promise(resolve => setTimeout(resolve, 500))
    }
  } finally {
    bot.off('path_update', onPath)
    bot.pathfinder.setGoal(null)
  }
}
