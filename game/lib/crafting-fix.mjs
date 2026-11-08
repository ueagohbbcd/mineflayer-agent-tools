// SPDX-License-Identifier: MIT
// Fix for consecutive crafts on 1.21.1: after bot.craft, leftovers stay in the
// 2x2 grid and the next crafts stop producing anything (counts unchanged,
// "missing ingredient", updateSlot timeouts) until reconnecting. Reproduced on
// a local 1.21.1 server with 20 crafts in a row, twice; with tidy() after each
// craft, every craft landed and the bot's inventory matched the server's.
//
//   fixCrafting(bot)   right after createBot: bot.craft tidies after itself
export function fixCrafting (bot) {
  // Mineflayer's own plugins (craft among them) attach a tick after createBot,
  // so wrap once logged in.
  bot.once('login', () => {
    const craft = bot.craft
    bot.craft = async (...args) => {
      try {
        return await craft.apply(bot, args)
      } finally {
        await tidy(bot)
      }
    }
  })
}

/** Close a crafting window, return what is left in the 2x2 grid and on the cursor. */
export async function tidy (bot) {
  if (bot.currentWindow) bot.closeWindow(bot.currentWindow)
  await bot.waitForTicks(2)
  const inv = bot.inventory
  for (let slot = 1; slot <= 4; slot++) {
    if (inv.slots[slot]) await bot.clickWindow(slot, 0, 1) // shift-click back
  }
  if (inv.selectedItem) {
    const empty = inv.firstEmptyInventorySlot()
    if (empty !== null) await bot.clickWindow(empty, 0, 0)
  }
  await bot.waitForTicks(2)
}
