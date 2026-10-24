---
name: mineflayer-surroundings
description: "Looking at the world from a Mineflayer bot: which chunks it knows, reading blocks live first with history only for unloaded chunks, entities, players and signs, pictures of terrain and structures, finding one tree's logs, and the radar and explore background modules. Use when a decision depends on what is around the character."
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

```js
import {
  observationViewBounds,
  surfaceSnapshotFromBot,
  renderTexturedSurface,
  saveRender,
} from "mineflayer-world-memory/live.mjs";

const view = observationViewBounds(bot, { viewRadius: 12 });
const snapshot = surfaceSnapshotFromBot(bot, view.local.bounds);
const { imagePath } = await saveRender(
  renderTexturedSurface(snapshot, { width: 512, height: 512 }),
  "./views/here",
);
```

North is up. Blank cells were not received. `snapshotFromBot` + `renderOblique` draws a small 3D box as plain cubes; read the `.png.json` beside the image for bounds and what is known. Pictures cost time and tokens; use `blockAt` and `findBlocks` for exact coordinates.

## Trees

`queryTreeCandidate({ blockAt: (p) => bot.blockAt(p), seed })` from `mineflayer-world-memory/queries.mjs` turns one log into the connected logs of that tree, with leaf evidence and where the search stopped. Your program decides which logs to dig.

## In the background, under `mf`

`mf run --keep "$MF_TOOLKIT_ROOT/runtime/default-scripts/radar.mjs"` logs players and named entities coming and going, where players are, mob counts and drops; `explore.mjs` logs blocks you have not seen before and sign text, and `mf log` sums the blocks up as types and counts. Both are read-only and write to `mf log`.

## Examples

- [watch-surroundings.mjs](../../examples/watch-surroundings.mjs): waits until a kind of block shows up nearby, then ends.
- [entity-radar.mjs](../../examples/entity-radar.mjs): nearby entities, logged when they change (read-only).
- [summarize-terrain.mjs](../../examples/summarize-terrain.mjs): local terrain and connectivity as numbers (read-only).
- [query-block-memory.mjs](../../examples/query-block-memory.mjs): one block, live first, history only for unloaded chunks (read-only).
