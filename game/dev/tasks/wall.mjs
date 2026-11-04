// Walk west into the wall; the step itself turns around after 12 s without
// progress. The no-progress notice (10 s) must not block that turn.
import pathfinderPkg from 'mineflayer-pathfinder'
const { goals } = pathfinderPkg
const WEST = Math.PI / 2
const EAST = -Math.PI / 2

export default async function task (bot, { steps }) {
  await bot.pathfinder.goto(new goals.GoalNear(-4, -60, 0, 0.5))
  let turned = false
  let last = bot.entity.position.clone()
  let stillTicks = 0
  return await steps(() => {
    const pos = bot.entity.position
    if (turned) {
      if (pos.x >= -1) return { done: true, result: { turned, x: Math.round(pos.x * 10) / 10 } }
      return { forward: true, look: { yaw: EAST, pitch: 0 } }
    }
    stillTicks = pos.distanceTo(last) < 0.01 ? stillTicks + 1 : 0
    last = pos.clone()
    if (stillTicks >= 240) turned = true
    return { forward: true, look: { yaw: WEST, pitch: 0 } }
  })
}
