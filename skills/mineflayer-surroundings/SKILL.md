---
name: mineflayer-surroundings
description: "Looking at the world from a Mineflayer bot: which chunks it knows, reading blocks live first with history only for unloaded chunks, entities, players and signs, pictures of terrain and structures, finding one tree's logs, and the radar and explore observers. Use when a decision depends on what is around the character."
---

# Looking at the world

## What the bot knows

- The bot only knows chunks the server has sent, roughly the server's view distance around it. Everything else is unknown, which is not the same as air.
- `bot.blockAt(position)` returns the block, or `null` when that chunk is not loaded.
- `bot.findBlocks({ matching, maxDistance, count })` searches loaded chunks near the bot; `matching` can be a block id, a list of ids, or a function of the block.
- `bot.entities` and `bot.nearestEntity(filter)` list entities the server reports near you; `bot.players` lists players.
- Signs: `block.getSignText()` on a sign block.

## Live first, history only for unloaded chunks

`readWorldBlock` gives one rule for every read:

```js
import { readWorldBlock } from "mineflayer-world-memory/reader.mjs";

const { block, source, observedAt } = readWorldBlock(bot, { x, y, z }, memory);
// source: "live" | "historical" | "unknown"
```

- Without history (`memory` = `null`) it is `bot.blockAt` with a clear `unknown`.
- With history (`createWorldMemory`, optional), a chunk the bot no longer has can still answer, as it was at `observedAt`. Something may have changed it since. A loaded chunk never falls back to history.

## Pictures

When a decision depends on shape (a doorway, a wall, stacked floors), take a picture instead of reading many blocks:

```sh
node game.mjs query <toolkit>/examples/screenshot.mjs                         # around your feet, two corner views
node game.mjs query <toolkit>/examples/screenshot.mjs -20 60 -20 20 80 20 top # a box from above, north up
node game.mjs query <toolkit>/examples/screenshot.mjs -19 60 -19 19 70 19 se open grid  # cutaway with block lines
node game.mjs query <toolkit>/examples/pick.mjs out/shot-3.png 410 285       # the block under that pixel
```

Only blocks inside the box are drawn, so a box that stops below a roof or inside a wall shows the interior. Missing cells were not received, not air. It needs the renderer's native parts (see `game/visual/README.md`); pictures cost time and tokens, so use `blockAt` and `findBlocks` for exact coordinates. `mineflayer-world-memory/live.mjs` also has a cheap top-down `renderTexturedSurface`.

## Trees

`queryTreeCandidate({ blockAt: (p) => bot.blockAt(p), seed })` from `mineflayer-world-memory/queries.mjs` turns one log into the connected logs of that tree, with leaf evidence and where the search stopped. Your program decides which logs to dig.

## Observers in the game process

main starts `radar` (players and named entities coming and going, where players are, mob counts, drops) and `explore` (blocks you have not seen before, sign text). They only record: `node report.mjs radar` / `node report.mjs explore [minutes]` show them, explore summed up as block types and counts.

## Examples

- [watch-surroundings.mjs](../../examples/watch-surroundings.mjs): waits until a kind of block shows up nearby, then ends.
- [entity-radar.mjs](../../examples/entity-radar.mjs): nearby entities, logged when they change (read-only).
- [summarize-terrain.mjs](../../examples/summarize-terrain.mjs): local terrain and connectivity as numbers (read-only).
- [query-block-memory.mjs](../../examples/query-block-memory.mjs): one block, live first, history only for unloaded chunks (read-only).
