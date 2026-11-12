# World memory

`createWorldMemory(bot, options)` (`index.js`) remembers native chunk columns the bot has received, including unloaded columns and other dimensions, tested with Minecraft Java 1.21.1. Recording is passive: exploration and movement stay with the caller. `readWorldBlock` (`reader.js` / `reader.mjs`) reads one block with the live world first.

## Record received chunks

```js
const { createWorldMemory } = require('mineflayer-world-memory')
const memory = createWorldMemory(bot, {
  directory: './memory', // optional; requires an explicit world identity
  worldId: 'my-server/my-world', // unique, stable identity; change on world reset
  entities: () => entityFacts.summary() // optional; supplied by your entity service
})
await memory.refresh() // wait for current analysis/persistence
console.log(memory.summary())
console.log(await memory.find({ name: 'nether_portal', dimension: 'overworld' }))
// Keep memory attached while the bot receives updates. On shutdown:
await memory.dispose()
```

The cache lives below `directory/base64url(worldId)`, scoped by dimension and
Minecraft version. Use a distinct identity for each world and after a reset.
Snapshot the cache for a fully consistent multi-chunk export while a bot writes;
atomic writes apply to individual files.

## Live first: `readWorldBlock`

For ordinary block queries the live Mineflayer world is authoritative.
`readWorldBlock(bot, position, memory)` returns a live block first; only a
remembered chunk that is currently *unloaded* may supply a historical,
possibly stale block. The result's `source` is `live`, `historical` or
`unknown` (unknown is not air), with `loaded` and `observedAt`. Pass `null`
for memory to read without any history. The read is synchronous: await
`memory.ready` before relying on restored history.

## Summary, exposure and exact reads

`summary()` is synchronous and returns the last completed result plus `pending`. Received changes automatically schedule background analysis. Call `refresh()` to await the current analysis pass; updates arriving during that pass schedule another pass and remain visible as `pending`. It identifies `currentDimension` and reports cumulative `blockCounts` across all remembered dimensions, and per-dimension `blockCounts`, `coverage`, `currentCoverage`, `chunks`, `loadedChunks`, and `lastObservedAt`. Revisions and timestamps reflect received world-state changes. Entity facts come directly from the supplied provider.

Coverage rectangles have minimum **block** `x,z` and `width,depth` measured in **chunks**. They exactly cover known chunk coordinates without filling gaps. Horizontal runs are merged vertically, and the analogous transposed result is used if it needs fewer rectangles. This deterministic compact cover favors a small rectangle count; a global minimum is unverified.

## Chunk surface heights

Each dimension also has `chunkSummaries`, one entry per remembered chunk:

```js
await memory.refresh()
const chunks = memory.summary().dimensions.overworld?.chunkSummaries || []
const candidates = chunks.filter(c => c.loaded && c.surface.coverage === 1 && c.surface.relief <= 2)
// Example entry (x,z are CHUNK coordinates):
// { x: -2, z: 3, loaded: true, observedAt: 1790000000000,
//   surface: { columns: 256, emptyColumns: 0, unknownColumns: 0, coverage: 1,
//              minY: 64, maxY: 66, meanY: 65, relief: 2, stddev: 0.7071 } }
```

`surface` measures the highest **non-air block Y** in each of the chunk's 256
horizontal columns, over the native column's `minY` and `worldHeight`. Only
`air`, `cave_air`, and `void_air` are skipped. This deliberately includes tree
canopies, water/lava surfaces, snow layers, plants and artificial roofs/platforms.
The highest roof takes precedence over cave floors; in a roofed dimension this
can measure the dimension ceiling. Natural ground, water depth, collision height
and safe standing positions require separate queries.

- `columns`: columns with a known top non-air block; these alone contribute to statistics.
- `emptyColumns`: known all-air columns in the scanned vertical range.
- `unknownColumns`: columns with an unrecognized/missing block state above any known non-air block. These are excluded from height statistics. A known top remains valid when unknown states lie below it.
- `coverage`: `columns / 256`. The three column counts sum to 256. Missing chunks have no entry; unloaded remembered chunks retain their last observations with `loaded: false`.
- `minY`, `maxY`, `meanY`: minimum, maximum and arithmetic mean block Y.
- `relief`: `maxY - minY`; `stddev`: population standard deviation in blocks.
  All five height statistics are `null` when `columns === 0`; height statistics
  require known surface columns.

Use these filtering hints alongside visual inspection. Check building footprints,
accessibility, ownership and permission to build locally. A footprint spanning
chunks needs per-column checks; the summary provides chunk-level statistics.
Exposed `blockCounts` are independent and include every positive count without truncation.

Heights are collected during the classification scan, with no additional
native voxel reads; only 256 temporary height/state slots are added per scan.
Unchanged chunks reuse their surface statistics. Received block/chunk updates
invalidate them along with the rest of the analysis. The same `revision`, `pending`,
`loaded` and `observedAt` freshness rules apply as for other memory results.
Persisted files hold only the native column; surface statistics are
recomputed from the restored column. Summary
results and their chunk entries are read-only snapshots.

Exposed means connected by six-neighbor transparent blocks to the top of a known column, plus opaque blocks adjacent to that connected space. The native registry's transparency and empty collision box define transparent space. Connections cross chunk boundaries, including unloaded remembered columns. Unknown space at a side or bottom boundary stays unclassified. Every native block type with a positive exposed count is included, including air. Exposure describes this connectivity, independently of the bot's camera and raycast history. Closed cavities remain hidden until a received update connects them to exposed space. Air positions use compact runs.

`find({name, dimension, limit=100})` refreshes pending work and reads indexed exposed positions. Its result includes `positions`, `total`, `remaining`, `revision`, and `pending`; every position includes `loaded` and `observedAt`. All known columns contribute to the total, regardless of the result limit. `chunk({x,z,dimension})` returns the remembered native column, using chunk coordinates. `block({x,y,z,dimension})` reads a remembered native block at block coordinates, including hidden blocks; absent columns return null. Treat returned columns and snapshots as read-only.

Analysis uses typed per-column component labels, unions neighboring components, and yields to the event loop in batches. Cached unchanged columns reuse their classification. Exposed-component signatures let unchanged columns reuse their position indexes and counts, while connectivity changes propagate through the full known component graph. Large explored worlds consume memory proportional to remembered voxel volume. Raw native columns are gzip persisted atomically by dimension and chunk, scoped to `worldId` and checked against the Minecraft version. Use a distinct world identity for each world and after a reset. Restoration happens asynchronously on creation; loading errors remain in `summary().error` for that memory instance, even after successful analysis. `dispose()` drains received updates and persistence before publishing the final unloaded index.

## Full-column readers without automatic exposure analysis

For a read service or archival observer, use `analysis: 'lazy'` (the default is `'eager'`):

```js
const memory = createWorldMemory(bot, {
  analysis: 'lazy',
  directory: './memory',
  worldId: 'world/reset/player' // keep independent worlds/resets/players isolated
})
await memory.ready // restored files and current received columns, no voxel scan
const info = memory.chunkInfo({ dimension: 'overworld', x: -1, z: 0 })
const block = memory.block({ dimension: 'overworld', x: -1, y: -40, z: 3 })
const columns = memory.chunks({ dimension: 'overworld' })
await memory.flush() // persist native columns without exposure analysis
```

`chunkInfo` and `chunks` return detached metadata: chunk coordinates, dimension,
`loaded`, `observedAt`, version, minimum Y and height. `revision` is the live
memory revision; `summary().revision` is the separately computed exposure
revision. A missing column is unknown; known air is a real block. Loaded records
take native column updates; unload keeps the last column, and the next load
replaces the complete record. Metadata `observedAt` records the latest captured
chunk/block event, not the time every unchanged cell was individually received.

Lazy mode saves dirty native columns automatically. It skips automatic
exposure classification, including on disposal. `refresh()` and `find()` are
explicit, potentially expensive exposure-analysis requests. `find()` searches
exposed blocks only; `block()` and `chunk()` include all received blocks, even
sealed blocks. `ready`, exact reads and metadata reads do not request analysis.
`chunk()` returns the underlying native object; services should serialize it
or wrap getters rather than expose mutation.

Every positive exposed block count is kept, including rare blocks. Per-chunk
height/relief statistics are lightweight hints, with null statistics for
empty/unknown surfaces. Check buildability locally.

## Tests and synthetic benchmark

Run `npm test` for the native chunk, persistence and terrain regression tests.
Run `node benchmark/terrain.js` for seven measured fresh-analysis trials (after
one warmup), each with 16 synthetic 384-block-tall chunks, plus 1,000 cached
refreshes. Optionally pass a baseline `index.js` path for the same workload.
The benchmark reports timings and native block-state reads for synthetic chunks.
Timing is environment-dependent. A run reads exactly 1,572,864 states on the first pass and zero on cached refreshes.
