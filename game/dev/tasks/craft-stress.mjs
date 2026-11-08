// Reproduces the 1.21.1 crafting desync: 20 crafts in a row (2x2 and table).
// Needs a crafting table within 4 blocks, 16 oak logs and 4 coal. Without
// fixCrafting, some crafts stop producing anything and the grid keeps items.
const count = (bot, n) => bot.inventory.items().filter(i => i.name === n).reduce((a, i) => a + i.count, 0)
export default async (bot, ctx) => {
  const table = bot.findBlock({ matching: bot.registry.blocksByName.crafting_table.id, maxDistance: 4 })
  const seq = ['oak_planks', 'oak_planks', 'oak_planks', 'stick', 'stick', 'oak_planks', 'wooden_pickaxe', 'oak_planks', 'stick', 'wooden_sword', 'oak_planks', 'oak_planks', 'chest', 'oak_planks', 'oak_button', 'oak_planks', 'oak_pressure_plate', 'torch', 'stick', 'torch']
  const out = []
  for (const name of seq) {
    const id = bot.registry.itemsByName[name].id
    const useTable = ['wooden_pickaxe', 'wooden_sword', 'chest'].includes(name) ? table : null
    const r = bot.recipesFor(id, null, 1, useTable)[0]
    if (!r) { out.push(`${name}: no recipe`); continue }
    const before = count(bot, name)
    try { await bot.craft(r, 1, useTable ?? undefined) } catch (e) { out.push(`${name}: ${e.message}`); continue }
    out.push(`${name} ${before}->${count(bot, name)}`)
  }
  await new Promise(r => setTimeout(r, 1000))
  return { out, items: bot.inventory.items().map(i => `${i.name}x${i.count}@${i.slot}`).join(' '), cursor: bot.inventory.selectedItem?.name ?? null, grid: [1, 2, 3, 4].map(s => bot.inventory.slots[s]?.name ?? null), win: bot.currentWindow?.type ?? null }
}
