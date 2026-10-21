# Getting around

Use [mineflayer-pathfinder](https://github.com/PrismarineJS/mineflayer-pathfinder). Its `Movements` decide what a path may do:

```js
const moves = new Movements(bot);
moves.canDig = false; // keep the terrain intact (default true)
moves.allow1by1towers = false; // no pillaring with blocks from the inventory
moves.allowParkour = true;
moves.maxDropDown = 4;
bot.pathfinder.setMovements(moves);
await bot.pathfinder.goto(new goals.GoalNear(x, y, z, 1));
```

Useful goals: `GoalBlock` (stand in that cell), `GoalNear` (within a range), `GoalXZ` (any height), `GoalFollow` (keep near an entity, dynamic), `GoalGetToBlock` (next to a block, for chests and crafting tables).

## Check arrival

`goto` resolving means Pathfinder reached its goal by its own test. If the next step needs an exact spot, check `bot.entity.position` yourself (for example X and Z equal after `floored()`, Y within one block).

## After NoPath or a stall

- `goto` rejects with `NoPath` when no route exists through the terrain the bot has received, and with a timeout when the search ran out of time. A goal far away is often outside loaded chunks: walk part of the way and try again from there.
- Look before retrying the same goal. Read the blocks along the way, or take a picture (see `surroundings.md`). Repeating the same failing goal is the most common way to waste time; the watchdog reports it as `repeat`.
- If the bot moves less than a block for half a minute while a goal is set, it is stuck: against a wall, in water, or on a ledge Pathfinder misjudges. Stop, look, and choose another route or let it dig or place.

## Stopping Pathfinder before using the hand

`bot.pathfinder.stop()` only asks Pathfinder to stop at the next path node. Before you use the main hand (eat, place, attack), wait until all three are true:

1. The original `goto` has rejected with `PathStopped`.
2. The bot is on the ground (`bot.entity.onGround`).
3. Pathfinder is not digging or placing (`bot.pathfinder.isMining()` and `bot.pathfinder.isBuilding()` are false).

Then set the original goal again if you want to continue.

## Waypoints

Once you know a place, write down a few footholds you will come back to: one per floor of a building, a doorway, a bridge end, a resource spot. Use the feet cell (the air block you stand in) and a short note. Plan trips between waypoints rather than recomputing from scratch, and update the list after the terrain changes (a bridge built, a ladder broken).
