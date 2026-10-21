# Staying alive

The game does not wait for you. With no program running the character stands still while mobs attack it or it drowns.

- **Eat:** `await bot.consume()` with food equipped; it returns after eating. Eat when `bot.food` drops, not only when health is low. `mineflayer-auto-eat` can do this beside a controller, but it takes the main hand.
- **Fight:** with `mineflayer-pvp`, `await bot.pvp.attack(entity)` and `await bot.pvp.stop()`. PvP gives Pathfinder its own settings, `bot.pvp.movements`; set `bot.pvp.movements.canDig = false` to keep it from digging during a fight even when your own Movements forbid digging.
- **Defend while walking:** watch `entityHurt` for yourself or hostile mobs within a few blocks, stop the walk (see "Stopping Pathfinder" in `navigation.md`), fight, then set the goal again.
- **Water:** in water get to air first: hold `jump` (`bot.setControlState("jump", true)`) until the head is out, watch `bot.oxygenLevel`.
- **Falls and lava:** check the block below and ahead before stepping or digging down.

## Respawn point

Right-click a bed with `await bot.activateBlock(bedBlock)` from within about two blocks, only when `bot.game.dimension` is `"overworld"`: in the Nether or the End a bed explodes. It works by day too; at night the bot also lies down (`bot.isSleeping`), and `await bot.wake()` gets it up. The game confirms with the chat line `Respawn point set`. After death (`death` event) the bot respawns at the bed while it stands and is not blocked; listen for `respawn`.
