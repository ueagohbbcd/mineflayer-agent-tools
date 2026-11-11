---
name: mineflayer-items
description: "Using items and blocks with a Mineflayer bot: digging, placing, equipping, crafting with the right number of runs, furnaces and other windows, and taking only what you need from chests. Use for any work with the hand or the inventory."
---

# Items, blocks and containers

- **Dig:** `await bot.dig(block)`. Check `bot.canDigBlock(block)` and equip a suitable tool first: `await bot.tool.equipForBlock(block)` with `mineflayer-tool` (loaded by the game template), or `bot.pathfinder.bestHarvestTool(block)`. Check below before digging down.
- **Collect blocks:** `await bot.collectBlock.collect(block)` (`mineflayer-collectblock`) walks to a block, digs it with the right tool and picks up the drop. It only breaks blocks the current Pathfinder movements may dig, and the game template walks without digging, so set digging movements in the task first: `bot.pathfinder.setMovements(new Movements(bot))`; main puts walking-only back when the task leaves. **Keep it on a short leash:** with digging movements its path search can run for minutes or exhaust main's memory (seen in a playtest: main crashed four times), and it digs through whatever is in the way, your crafting table and furnace included. Give it one nearby block at a time (within about 16 blocks), race each call against a timeout of about 40 s and call `bot.collectBlock.cancelTask()` when it loses, and skip a block that failed. For ore a few blocks away, walking next to it and `bot.dig` is safer.
- **Place:** `await bot.placeBlock(referenceBlock, faceVector)` places against a face of an existing block. Make sure no entity (including you) stands in the target cell.
- **Equip:** `await bot.equip(item, "hand")`. The main hand is shared by every program on the bot; equip the right item again each time a program resumes, because an eating or fighting program may have changed it.
- **Craft:** `bot.recipesFor(itemType, metadata, minResultCount, table)` lists recipes the current inventory can make; `await bot.craft(recipe, runs, table)` makes them. `runs` counts recipe executions, so use `Math.ceil(wanted / recipe.result.count)`. Pass `null` as `table` for 2×2 recipes; otherwise stand near a crafting table and pass its block. On 1.21.1, crafts in a row leave items in the 2×2 grid and later crafts silently produce nothing until a reconnect; the game template's `fixCrafting(bot)` clears the grid after every `bot.craft`. Without it, close the window and shift-click grid slots 1–4 back after each craft, and check the count rose.
- **Furnaces, anvils, enchanting tables, villagers:** `openFurnace`, `openAnvil`, `openEnchantmentTable`, `openVillager`. A furnace's `fuel` and `progress` update over time; read them again after waiting.

## Chests

1. Open and look: `const window = await bot.openContainer(chestBlock)`, then `window.containerItems()`.
2. Decide what you need. Take only that: a full inventory makes the next chest useless. Check `bot.inventory.emptySlotCount()` first.
3. Transfer with the numeric item type, not the name: `await window.withdraw(item.type, item.metadata, count, item.nbt)` with `item` from `window.containerItems()`; `window.deposit(...)` is the reverse.
4. `window.close()` when done.

If you look in one program and take in the next, check that `bot.currentWindow` is still that chest; open it again if it closed.

## Examples

- [craft-and-count.mjs](../../game/experimental/craft-and-count.mjs): `craftAndCount`, crafting by name; it fails with "wanted N, got M" unless the requested count arrived.
- [inspect-placement-entities.mjs](../../examples/inspect-placement-entities.mjs): checking that no entity blocks a placement (read-only).
