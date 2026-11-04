import { airOf } from 'mineflayer-world-memory/game/index.mjs'
// Plugin walks to the channel entrance, then the prebuilt loop walks east
// along the bottom of the 3-deep channel until x >= 48.
import pathfinderPkg from 'mineflayer-pathfinder'
const { goals } = pathfinderPkg
const EAST = -Math.PI / 2

export default async function task (bot, { steps }) {
  await bot.pathfinder.goto(new goals.GoalNear(8, -60, 0, 0.5))
  let minAir = 20
  const started = Date.now()
  return await steps(() => {
    minAir = Math.min(minAir, airOf(bot))
    if (bot.entity.position.x >= 48) return { done: true, result: { reached: true, minAir } }
    if (Date.now() - started > 90000) return { done: true, result: { reached: false, minAir } }
    return { forward: true, look: { yaw: EAST, pitch: 0 } }
  })
}
