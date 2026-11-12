// SPDX-License-Identifier: MIT
// Experimental (see README): craft by item name and count what arrived.
// The grid clean-up itself is in lib/crafting-fix.mjs. Stops at entry and
// after the craft when ctx.signal has aborted.
//
//   await craftAndCount(bot, ctx, 'stick', 4)
//   await craftAndCount(bot, ctx, 'iron_pickaxe', 1)          a table within reach, or one placed from the inventory
//   node game.mjs run <toolkit>/game/experimental/craft-and-count.mjs stick:4 wooden_pickaxe:1
import { placeNear } from './place-near.mjs'
// Does: crafts `count` of `itemName` (with `table` when given): the recipe
//   runs ceil(count / its result count) times, so the request implies that
//   many runs × the result count. Returns { item, wanted, before, after } when
//   the inventory count rose by at least that much; otherwise throws
//   "... wanted N, got M", with the craft's own error when it threw one.
// Checked: 2026-11-10, local 1.21.1: 20 crafts in a row (craft-and-count.mjs),
//   all counts rose, inventory matched the server (1 run). 2026-11-11: the same
//   20 crafts passed again; 8 sticks from 2 planks failed with "wanted 8, got 4"
//   and the craft's "missing ingredient" (2 runs).
//   A recipe that needs a table, with no `table` given: uses a crafting table
//   within reach, or places one from the inventory (placeNear) — all three
//   players wrote this, and walking back to an old table failed from a pit.
// Limits: relies on fixCrafting in main for consecutive crafts; it detects a
//   short or desynced inventory but does not repair it. Counting by the
//   request answers a playtest where 8 sticks were asked for and 4 arrived.
//   The table branch: 2026-11-12, crafted a table and placed it for iron
//   armour (1 run).
export async function craftAndCount (bot, ctx, itemName, count = 1, table = null) {
  ctx.signal.throwIfAborted()
  const item = bot.registry.itemsByName[itemName]
  if (!item) throw new Error(`no item named ${itemName}`)
  if (!table && !bot.recipesFor(item.id, null, 1, null)[0] && bot.recipesFor(item.id, null, 1, true)[0]) {
    const eyes = bot.entity.position.offset(0, 1.62, 0)
    table = bot.findBlock({ matching: bot.registry.blocksByName.crafting_table.id, maxDistance: 5, useExtraInfo: b => b.position.offset(0.5, 0.5, 0.5).distanceTo(eyes) <= 4.5 })
    if (!table && bot.inventory.items().some(i => i.name === 'crafting_table')) table = await placeNear(bot, ctx, 'crafting_table')
    if (!table) throw new Error(`${itemName} needs a crafting table: none within reach and none in the inventory; craft one (4 planks)`)
  }
  const recipe = bot.recipesFor(item.id, null, 1, table)[0]
  if (!recipe) throw new Error(`no recipe for ${itemName} that the inventory can make${table ? '' : ' without a crafting table'}`)
  const runs = Math.ceil(count / recipe.result.count)
  const wanted = runs * recipe.result.count
  const before = countOf(bot, itemName)
  let failure = null
  try {
    await bot.craft(recipe, runs, table ?? undefined)
  } catch (error) {
    failure = error
  }
  ctx.signal.throwIfAborted()
  const after = countOf(bot, itemName)
  if (after - before < wanted) {
    throw new Error(`crafting ${itemName}: wanted ${wanted}, got ${after - before} (${before} → ${after})` +
      (failure ? `; the craft failed: ${String(failure.message).replace(/^Error: /, '')}` : '; the inventory may be out of sync'))
  }
  return { item: itemName, wanted, before, after }
}

const countOf = (bot, name) => bot.inventory.items().filter(i => i.name === name).reduce((n, i) => n + i.count, 0)

// As a job: run craft-and-count.mjs NAME:COUNT [NAME:COUNT ...], in order.
export default async function task (bot, ctx) {
  if (!ctx.args.length) throw new Error('usage: run craft-and-count.mjs NAME:COUNT [NAME:COUNT ...]')
  const done = []
  for (const spec of ctx.args) {
    const [name, n = 1] = spec.split(':')
    const r = await craftAndCount(bot, ctx, name, Number(n))
    ctx.log(`${name}: ${r.before} → ${r.after}`)
    done.push(r)
  }
  return done
}
