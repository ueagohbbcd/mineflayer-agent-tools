// Walks into the wall for 15 s with no plan B; the no-progress rule should
// tell the model at 10 s while the task is still running.
import pathfinderPkg from 'mineflayer-pathfinder'
const { goals } = pathfinderPkg
const WEST = Math.PI / 2

export default async function task (bot, { steps }) {
  await bot.pathfinder.goto(new goals.GoalNear(-4, -60, 0, 0.5))
  const until = Date.now() + 15000
  return await steps(() => {
    if (Date.now() > until) return { done: true, result: 'gave up' }
    return { forward: true, look: { yaw: WEST, pitch: 0 } }
  })
}
