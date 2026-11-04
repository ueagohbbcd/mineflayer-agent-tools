// Starts floating in the channel. Pathfinder cannot plan from a floating
// start, so the prebuilt loop swims to the north bank first. Then the plugin
// goes to the far side of the lake on its own (plugin-exclusive); with default
// Movements it walks around the lake instead of swimming (ticksInWater = 0).
import pathfinderPkg from 'mineflayer-pathfinder'
const { goals } = pathfinderPkg
const NORTH = 0

export default async function task (bot, { steps }) {
  await steps(() => {
    const p = bot.entity.position
    if (bot.entity.onGround && !bot.entity.isInWater && p.z <= -1.6) return { done: true }
    return { forward: true, jump: true, look: { yaw: NORTH, pitch: 0 } }
  })
  const goal = new goals.GoalNear(74, -60, 0, 0.5)
  const from = bot.entity.position.clone()
  let minAir = 20
  let wet = 0
  const onTick = () => {
    minAir = Math.min(minAir, bot.oxygenLevel ?? 20)
    if (bot.blockAt(bot.entity.position)?.name === 'water') wet++
  }
  bot.on('physicsTick', onTick)
  try {
    await bot.pathfinder.goto(goal)
  } finally {
    bot.removeListener('physicsTick', onTick)
  }
  const p = bot.entity.position
  if (!goal.isEnd(p.floored())) throw new Error(`goto 返回了，但没到目标：现在在 ${p.x.toFixed(1)} ${p.y.toFixed(1)} ${p.z.toFixed(1)}`)
  return { crossed: true, from: [from.x, from.y, from.z].map(n => Math.round(n * 10) / 10), ticksInWater: wet, minAir }
}
