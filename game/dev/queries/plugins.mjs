// Read-only: which plugins are loaded and what Pathfinder, pvp and collectblock
// will move with (walking only = canDig false, no towering, no scaffolding).
export default async function query (bot) {
  const m = bot.pathfinder?.movements
  return {
    plugins: {
      pathfinder: Boolean(bot.pathfinder),
      pvp: Boolean(bot.pvp),
      autoEat: Boolean(bot.autoEat),
      armorManager: Boolean(bot.armorManager),
      tool: Boolean(bot.tool),
      collectBlock: Boolean(bot.collectBlock)
    },
    movements: m && { canDig: m.canDig, allow1by1towers: m.allow1by1towers, scafoldingBlocks: m.scafoldingBlocks?.length ?? null },
    pvpMovements: bot.pvp ? bot.pvp.movements ?? null : 'no pvp',
    collectBlockMovements: bot.collectBlock ? bot.collectBlock.movements ?? null : 'no collectblock',
    health: bot.health,
    food: bot.food,
    held: bot.heldItem?.name ?? null,
    position: bot.entity.position.toArray().map(n => Math.round(n * 10) / 10)
  }
}
