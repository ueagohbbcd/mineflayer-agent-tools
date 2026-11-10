// Read-only: health, position and what pvp is fighting, for fight.mjs.
export default async function query (bot) {
  const p = bot.entity.position
  return {
    health: bot.health,
    food: bot.food,
    position: [p.x, p.y, p.z],
    held: bot.heldItem?.name ?? null,
    pvpTarget: bot.pvp?.target?.name ?? null
  }
}
