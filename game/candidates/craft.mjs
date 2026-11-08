// SPDX-License-Identifier: MIT
// Candidate (see README): craft by item name and check that the count rose.
// The grid clean-up itself is in lib/crafting-fix.mjs.
export async function craftChecked (bot, itemName, count = 1, table = null) {
  const item = bot.registry.itemsByName[itemName]
  if (!item) throw new Error(`没有物品 ${itemName}`)
  const recipe = bot.recipesFor(item.id, null, 1, table)[0]
  if (!recipe) throw new Error(`没有可用的 ${itemName} 配方${table ? '' : '（不带工作台）'}`)
  const before = countOf(bot, itemName)
  await bot.craft(recipe, Math.ceil(count / recipe.result.count), table ?? undefined)
  const after = countOf(bot, itemName)
  if (after <= before) throw new Error(`合成 ${itemName} 后数量没有增加（${before} → ${after}），背包可能不同步`)
  return { item: itemName, before, after }
}

const countOf = (bot, name) => bot.inventory.items().filter(i => i.name === name).reduce((n, i) => n + i.count, 0)
