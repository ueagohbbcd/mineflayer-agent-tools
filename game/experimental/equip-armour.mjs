// SPDX-License-Identifier: MIT
// Experimental (see README): put on the best armour in the inventory.
// mineflayer-armor-manager only acts on armour picked up from the ground;
// crafted armour stayed in the inventory for all three players (playtest 2026-11-10).
//
//   const worn = await equipArmour(bot, ctx)     → { head, torso, legs, feet } item names
//   node game.mjs run <toolkit>/game/experimental/equip-armour.mjs

const SLOTS = { helmet: 'head', chestplate: 'torso', leggings: 'legs', boots: 'feet' }
const WORN_SLOT = { head: 5, torso: 6, legs: 7, feet: 8 } // bot.inventory.slots
const MATERIALS = ['leather', 'golden', 'chainmail', 'iron', 'turtle', 'diamond', 'netherite'] // worse to better

// Does: for each of head, torso, legs and feet, equips the best piece in the
//   inventory when it is better than what is worn (by material: netherite >
//   diamond > turtle > iron > chainmail > golden > leather). Returns what is
//   worn afterwards.
// Checked: 2026-11-12, local 1.21.1: four crafted iron pieces put on (1 run);
//   leather boots replaced by diamond ones, a golden chestplate kept over a
//   leather one (1 run).
// Limits: ignores enchantments and durability.
export async function equipArmour (bot, ctx) {
  ctx.signal.throwIfAborted()
  for (const [kind, slot] of Object.entries(SLOTS)) {
    const best = bot.inventory.items().filter(i => i.name.endsWith(`_${kind}`)).sort((a, b) => rank(b) - rank(a))[0]
    const worn = bot.inventory.slots[WORN_SLOT[slot]]
    if (!best || (worn && rank(worn) >= rank(best))) continue
    await bot.equip(best, slot)
    ctx.signal.throwIfAborted() // exit rule: our own await, so check the signal
    ctx.log(`wearing ${best.name}`)
  }
  return Object.fromEntries(Object.entries(WORN_SLOT).map(([slot, n]) => [slot, bot.inventory.slots[n]?.name ?? null]))
}

const rank = item => MATERIALS.indexOf(item.name.split('_')[0])

// As a job: run equip-armour.mjs
export default async function task (bot, ctx) {
  return equipArmour(bot, ctx)
}
