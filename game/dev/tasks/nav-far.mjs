import pathfinderPkg from 'mineflayer-pathfinder'
const { goals } = pathfinderPkg

export default async function task (bot) {
  await bot.pathfinder.goto(new goals.GoalNear(55, -60, 10, 1))
  return { arrived: bot.entity.position.floored().toString() }
}
