// SPDX-License-Identifier: MIT
// Experimental (see README): craft by item name and count what arrived.
// The grid clean-up itself is in lib/crafting-fix.mjs. Stops at entry and
// after the craft when ctx.signal has aborted.
//
//   await craftAndCount(bot, ctx, 'stick', 4, tableBlock)
// Does: crafts `count` of `itemName` (with `table` when given): the recipe
//   runs ceil(count / its result count) times, so the request implies that
//   many runs × the result count. Returns { item, wanted, before, after } when
//   the inventory count rose by at least that much; otherwise throws
//   "... wanted N, got M", with the craft's own error when it threw one.
// Checked: 2026-11-10, local 1.21.1: 20 crafts in a row (craft-and-count.mjs),
//   all counts rose, inventory matched the server (1 run). 2026-11-11: the same
//   20 crafts passed again; 8 sticks from 2 planks failed with "wanted 8, got 4"
//   and the craft's "missing ingredient" (2 runs).
// Limits: relies on fixCrafting in main for consecutive crafts; it detects a
//   short or desynced inventory but does not repair it. Counting by the
//   request answers a playtest where 8 sticks were asked for and 4 arrived.
export async function craftAndCount (bot, ctx, itemName, count = 1, table = null) {
  ctx.signal.throwIfAborted()
  const item = bot.registry.itemsByName[itemName]
  if (!item) throw new Error(`no item named ${itemName}`)
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
