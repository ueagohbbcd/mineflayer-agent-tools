---
name: mineflayer-survival
description: "Keeping a Mineflayer character alive: eating, fighting with PvP, defending while walking, water and air, falls and lava, beds and respawn points, and the game process's reflexes that keep you alive. Use before trips into danger and when the character takes damage."
---

# Staying alive

The game does not wait for you. With no program running the character stands still while mobs attack it or it drowns.

- **Eat:** `await bot.consume()` with food equipped; it returns after eating. Eat when `bot.food` drops, not only when health is low. The game template loads `mineflayer-auto-eat` with automatic eating off: `await bot.autoEat.eat()` picks the best food it has (skipping rotten flesh and the like), eats it and puts the previous item back in the hand.
- **Fight:** with `mineflayer-pvp`, `await bot.pvp.attack(entity)` and `await bot.pvp.stop()`. PvP switches Pathfinder to its own digging settings, `bot.pvp.movements`, on each attack unless that is `null`; the game template sets it to `null` so fights keep the walking-only settings. The template also loads `mineflayer-armor-manager`, which puts on better armour when it is picked up from the ground; armour you craft stays in the inventory until a task equips it: `await equipArmour(bot, ctx)` from `game/experimental/equip-armour.mjs` puts on the best of each piece (or `await bot.equip(item, 'head' | 'torso' | 'legs' | 'feet')`).
- **Defend while walking:** watch `entityHurt` for yourself or hostile mobs within a few blocks, stop the walk (see "Stopping Pathfinder" in the `mineflayer-navigation` skill), fight, then set the goal again.
- **Water:** in water get to air first: hold `jump` (`bot.setControlState("jump", true)`) until the head is out, watch the air with `oxygenOf(bot)` from `mineflayer-world-memory/game/index.mjs` (`bot.oxygenLevel` can be another entity's air). Main's `surfaceForAir` reflex takes over any job when the head is under water with air at 10/20 or less; under a solid lid it digs up, which is slow while swimming, so mine near water with a way up. Digging that lets water reach your head (an aquifer) is the usual way to drown: `digNearby` hands over to `surfaceForAir` as soon as that happens.
- **Nights:** `sealIn(bot, ctx)` (`seal-in.mjs`) walls you into the two cells you stand in with blocks you carry (cobblestone, dirt) and checks the space is closed; it returns which blocks to dig to leave. As a job it waits for dawn and wakes `wait` once you are sealed in.
- **Falls and lava:** check the block below and ahead before stepping or digging down.

## Respawn point

Right-click a bed with `await bot.activateBlock(bedBlock)` from within about two blocks, only when `bot.game.dimension` is `"overworld"`: in the Nether or the End a bed explodes. It works by day too; at night the bot also lies down (`bot.isSleeping`), and `await bot.wake()` gets it up. The game confirms with the chat line `Respawn point set`. After death (`death` event) the bot respawns at the bed while it stands and is not blocked; listen for `respawn`.

## In the game process

Fighting back, eating, getting out of blocks and out of water are main's reflexes (`fightOrFlee`, `eatWhenHungry`, `digHeadFree`, `surfaceForAir` in [reflexes.mjs](../../game/experimental/reflexes.mjs)), built on mineflayer-pvp, mineflayer-auto-eat and mineflayer-tool. When they preempt a task is in `mineflayer-game`. The `wait` report's damage section names what hurt you (mob, suffocation, fall, drowning); its upkeep section says what idle and the reflexes ate, fought and fled from, a tool that broke, and food running low with nothing to eat.
