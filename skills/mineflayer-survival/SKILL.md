---
name: mineflayer-survival
description: "Keeping a Mineflayer character alive: eating, fighting with PvP, defending while walking, water and air, falls and lava, beds and respawn points, and the danger background module. Use before trips into danger and when the character takes damage."
---

# Staying alive

The game does not wait for you. With no program running the character stands still while mobs attack it or it drowns.

- **Eat:** `await bot.consume()` with food equipped; it returns after eating. Eat when `bot.food` drops, not only when health is low. `mineflayer-auto-eat` can do this beside a controller, but it takes the main hand.
- **Fight:** with `mineflayer-pvp`, `await bot.pvp.attack(entity)` and `await bot.pvp.stop()`. PvP gives Pathfinder its own settings, `bot.pvp.movements`; set `bot.pvp.movements.canDig = false` to keep it from digging during a fight even when your own Movements forbid digging.
- **Defend while walking:** watch `entityHurt` for yourself or hostile mobs within a few blocks, stop the walk (see "Stopping Pathfinder" in the `mineflayer-navigation` skill), fight, then set the goal again.
- **Water:** in water get to air first: hold `jump` (`bot.setControlState("jump", true)`) until the head is out, watch `bot.oxygenLevel`.
- **Falls and lava:** check the block below and ahead before stepping or digging down.

## Respawn point

Right-click a bed with `await bot.activateBlock(bedBlock)` from within about two blocks, only when `bot.game.dimension` is `"overworld"`: in the Nether or the End a bed explodes. It works by day too; at night the bot also lies down (`bot.isSleeping`), and `await bot.wake()` gets it up. The game confirms with the chat line `Respawn point set`. After death (`death` event) the bot respawns at the bed while it stands and is not blocked; listen for `respawn`.

## Under `mf`

- The `danger` background module (`mf run --keep "$MF_TOOLKIT_ROOT/runtime/default-scripts/danger.mjs"`) logs damage, risks near you (a swelling creeper, lit TNT, a projectile, something targeting you), hunger and air; the serious ones are urgent and make a waiting `mf run` return early.
- Between programs, idle fights hostile mobs within a few blocks, eats and holds jump in water; while a program runs, keeping the character alive is that program's job.

## Examples

- [fight-target.mjs](../../examples/fight-target.mjs): attacking a chosen entity with PvP.
- [navigate-with-defense.mjs](../../examples/navigate-with-defense.mjs): a trip that fights back and resumes.
