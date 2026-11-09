---
name: mineflayer-survival
description: "Keeping a Mineflayer character alive: eating, fighting with PvP, defending while walking, water and air, falls and lava, beds and respawn points, and the game process's services that keep you alive. Use before trips into danger and when the character takes damage."
---

# Staying alive

The game does not wait for you. With no program running the character stands still while mobs attack it or it drowns.

- **Eat:** `await bot.consume()` with food equipped; it returns after eating. Eat when `bot.food` drops, not only when health is low. The game template loads `mineflayer-auto-eat` with automatic eating off: `await bot.autoEat.eat()` picks the best food it has (skipping rotten flesh and the like), eats it and puts the previous item back in the hand.
- **Fight:** with `mineflayer-pvp`, `await bot.pvp.attack(entity)` and `await bot.pvp.stop()`. PvP switches Pathfinder to its own digging settings, `bot.pvp.movements`, on each attack unless that is `null`; the game template sets it to `null` so fights keep the walking-only settings. The template also loads `mineflayer-armor-manager`, which puts on better armour as it is picked up.
- **Defend while walking:** watch `entityHurt` for yourself or hostile mobs within a few blocks, stop the walk (see "Stopping Pathfinder" in the `mineflayer-navigation` skill), fight, then set the goal again.
- **Water:** in water get to air first: hold `jump` (`bot.setControlState("jump", true)`) until the head is out, watch the air with `oxygenOf(bot)` from `mineflayer-world-memory/game/index.mjs` (`bot.oxygenLevel` can be another entity's air).
- **Falls and lava:** check the block below and ahead before stepping or digging down.

## Respawn point

Right-click a bed with `await bot.activateBlock(bedBlock)` from within about two blocks, only when `bot.game.dimension` is `"overworld"`: in the Nether or the End a bed explodes. It works by day too; at night the bot also lies down (`bot.isSleeping`), and `await bot.wake()` gets it up. The game confirms with the chat line `Respawn point set`. After death (`death` event) the bot respawns at the bed while it stands and is not blocked; listen for `respawn`.

## In the game process

Fighting back, eating and getting out of blocks are main's services (`defend`, `eat`, `escape` in [services.mjs](../../game/candidates/services.mjs)), built on mineflayer-pvp, mineflayer-auto-eat and mineflayer-tool. What they take over and when is in `mineflayer-game`. The `wait` report's 受伤 section names what hurt you (mob, suffocation, fall, drowning).
