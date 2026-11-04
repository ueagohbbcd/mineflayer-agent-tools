// Read-only: where the bot is, what it stands on, what the pathfinder is doing.
export default async function query (bot) {
  const p = bot.entity.position
  return {
    position: [p.x, p.y, p.z].map(n => Math.round(n * 10) / 10),
    standingOn: bot.blockAt(p.offset(0, -1, 0))?.name,
    goal: bot.pathfinder?.goal ? bot.pathfinder.goal.constructor.name : null,
    moving: bot.pathfinder?.isMoving?.() ?? null
  }
}
