// 20 crafts in a row with craftAndCount (2x2 and crafting table mixed).
// Needs a crafting table within 4 blocks, 16 oak logs and 4 coal. Returns
// each step and the final counts, to compare with the server
// (RCON: clear <name> <item> 0 prints the server's count).
import { craftAndCount } from 'mineflayer-world-memory/game/experimental/craft-and-count.mjs'

const TABLE_ITEMS = ['wooden_pickaxe', 'wooden_sword', 'chest']
const count = (bot, n) => bot.inventory.items().filter(i => i.name === n).reduce((a, i) => a + i.count, 0)

export default async function task (bot, ctx) {
  const table = bot.findBlock({ matching: bot.registry.blocksByName.crafting_table.id, maxDistance: 4 })
  if (!table) throw new Error('no crafting table within 4 blocks')
  const seq = ['oak_planks', 'oak_planks', 'oak_planks', 'stick', 'stick', 'oak_planks', 'wooden_pickaxe', 'oak_planks', 'stick', 'wooden_sword', 'oak_planks', 'oak_planks', 'chest', 'oak_planks', 'oak_button', 'oak_planks', 'oak_pressure_plate', 'torch', 'stick', 'torch']
  const steps = []
  let failed = 0
  for (const name of seq) {
    try {
      const r = await craftAndCount(bot, ctx, name, 1, TABLE_ITEMS.includes(name) ? table : null)
      steps.push(`${name} ${r.before}->${r.after}`)
    } catch (error) {
      if (ctx.signal.aborted) return
      failed++
      steps.push(`${name}: ${error.message}`)
    }
  }
  await bot.waitForTicks(20)
  if (ctx.signal.aborted) return
  const names = ['oak_log', 'oak_planks', 'stick', 'coal', 'torch', 'chest', 'wooden_pickaxe', 'wooden_sword', 'oak_button', 'oak_pressure_plate']
  return {
    failed,
    steps,
    counts: Object.fromEntries(names.map(n => [n, count(bot, n)])),
    grid: [1, 2, 3, 4].map(s => bot.inventory.slots[s]?.name ?? null),
    cursor: bot.inventory.selectedItem?.name ?? null
  }
}
