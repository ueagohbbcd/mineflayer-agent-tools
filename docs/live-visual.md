# Caller-driven JavaScript world views

`visual.live` adds small synchronous capture/render functions to this package's
existing visual tools. “Live” means that the caller supplies its current bot or
local mirror. Importing it opens no sockets, starts no browser, installs no
listeners, and runs no polling loop. Call it only when a view is useful.
Ordinary JavaScript still owns goals, movement, retries and actions.

## Find the right capability

- Need the full loaded-map extent or a crop at the player's current layer:
  `observationViewBounds(bot, options)`.
- Need an overview or current-layer image now: `surfaceSnapshotFromBot` followed
  by `renderTexturedSurface` (CPU) or `renderSurfaceMinimap` (schematic).
- Need the shape of a small local structure: `snapshotFromBot` followed by
  `renderOblique`. It draws schematic opaque cubes, not exact block models.
- Need a view of explicitly retained historical observations:
  `snapshotFromExplored`, followed by `renderMinimap` or `renderOblique`.
- Need offline cached-world surfaces, layered transparency, biome boundaries,
  model-aware local 3D, or an underground air cast: keep using the existing
  [visual tools](visual.md) and [local 3D](local-3d.md).

## Smallest live-view call

```js
import {
  observationViewBounds, surfaceSnapshotFromBot,
  renderTexturedSurface, saveRender,
} from 'mineflayer-world-memory/live.mjs'

// bot is an already connected Mineflayer bot, or a synchronous local mirror.
const selection = observationViewBounds(bot, { viewRadius: 12 })
const snapshot = surfaceSnapshotFromBot(bot, selection.local.bounds)
const render = renderTexturedSurface(snapshot, { width: 512, height: 512 })
const { imagePath, metadataPath } = await saveRender(render, './views/local')
```

For CJS use `require('mineflayer-world-memory/live.js')`, or
`require('mineflayer-world-memory').visual.live`. Named ESM and CJS exports refer
to the same functions. Render results contain `{ png, rgba, metadata }` in memory.
The consumer decides whether to display them; no UI, player marker, opening
collage, team or match state is added by this library.

`saveRender(render, outputBase)` writes `<outputBase>.png` and
`<outputBase>.png.json`. This lightweight live helper **overwrites** those two
paths to support refreshed maps; use a unique base for history. Existing offline
exporters/renderers retain their no-overwrite protections. Both live files are
ordinary local files; the helper does not provide a cross-file transaction.

## Capture inputs and source truth

Bounds are inclusive integer `{ min: { x, y, z }, max: { x, y, z } }` in blocks.
All capture uses synchronous `blockAt(Vec3)`. Native Mineflayer's
`world.getColumns()` and a mirror's `columns: Map<"chunkX,chunkZ", { chunk }>`
are supported. A full loaded chunk establishes air only inside its declared
height. Missing columns, `null` blocks and `{ known: false }` remain unknown.
The helpers do not request chunks or read a server's private world storage.

`observationViewBounds` returns independent `overview`, `local` and `3d`
selections. Overview uses explicit `overviewBounds`/`publicMapBounds`, otherwise
loaded column extent, observed block extent, or only the player's column.
Local is feet Y − 1 through Y + 2 and radius 12 by default; `3d` is Y − 8
through Y + 16. Known dimension height clips Y, but an old loaded X/Z extent
never drags a local crop away from a teleported player. `localBounds` and
`structureBounds` override their crops. A missing/invalid player position throws;
a consumer can continue showing its unrelated player-state sample.

`surfaceSnapshotFromBot(bot, bounds, options)` stores one compact `columns`
entry per X/Z: `{ x, z, known, unknownAbove, top }`. `known` counts known selected
Y cells; `top` is the highest observed non-air block, including name, state ID
and available properties. An unknown gap above it is explicitly hatched. A
partial all-air column is never promoted to a known-clear column.

This is an in-memory, one-top-face view input. It is intentionally **not** the
persistent `world-memory.surface-map.v1` layered cache format: a lightweight
mirror may have names without native state IDs, or gaps above a lower known
block. Neither schema is relabelled as the other. Existing `visual.surface`,
`exportSurface`, native cache identity checks and offline renderers are unchanged.

`surfaceSnapshotFromBot` caps columns at 262,144 and sample work at 134,217,728;
`maxColumns` and `maxSamples` can lower these limits. A full 128×128×384 loaded
region needs 16,384 compact entries rather than millions of block objects.
`snapshotFromBot(bot, { bounds, maxVoxels })` captures explicit known cells,
including air; default acquisition cap is 1,000,000 voxels and the renderer's
hard bound is 4,000,000. Budgets reject with an error instead of silently cutting
a requested image. Render dimensions must total at most 16,777,216 pixels.

Historical capture is opt-in and reads only an adapter's
`knownBlocksIn(bounds)` or `knownBlocks.values()`, yielding
`{ block, observedAt, epoch }`. It keeps observation time, age and epoch, supports
`maxAgeMs`, and marks a record stale when it is no longer currently known, its
current block state differs, or its epoch differs. It does not create a second
memory store or treat unloaded history as the present world.

## Actual textures, explicit limitations

Install Prismarine Viewer separately only if wanted; it is an optional peer,
not a required browser renderer or a runtime download. The default CPU texture
path reads its locally installed `public/textures/<version>.png` and
`public/blocksStates/<version>.json`. Viewer may map a game version to a nearby
supported asset version; metadata reports `version` and `renderVersion` separately.
Alternatively pass `assetsPath` pointing to your own compatible `public`
directory and, if needed, `assetVersion` explicitly. Use resources you are
entitled to use. This package ships no Minecraft texture/model assets or worlds.

The renderer selects an upward texture face using block state properties and
Viewer's variant/face rotation conventions. It is a CPU **top-face projection**:
partial shapes are flattened, random variants use their first model, biome tints
use defaults, and alpha composites over a material color. Multipart/entity blocks
or states without a reliable static upward face retain a schematic material
color. Metadata lists these material fallbacks, flattened shapes and defaulted
states. Missing/malformed texture assets return a whole-view schematic fallback
with `renderer.fallback: true` and a reason; consumers can reject that result if
actual textures are mandatory.

Maps have no text, grid or cards. Aspect ratio is preserved. Default image axes
are right +X/east and up −Z/north; `horizontalAxis: 'z'` swaps the map axes and
texture coordinates together. Purple marks unknown data and unknown-above gaps;
amber stripes mark stale history. Sidecar metadata carries inclusive bounds,
viewport/pixels per block, coverage, source description, available source times,
epoch/sequence and render time. `acquiredAt`/`renderedAt` are not invented source
observation times. Images are useful spatial evidence, not proof of walkability,
visibility, cave connectivity or a complete map.

## Verification and reuse

`npm test` covers native chunk/Vec3 inputs, unknown-vs-air, observation history,
large compact overviews, budgets, direction/UV rotation, mirrored atlas boundaries,
missing assets and sidecar delivery. Textured unit tests generate a tiny
self-authored atlas at runtime; no game assets are committed. Existing Python
visual tests remain `npm run test:visual`.

These MIT generic primitives were contributed from the craft-arena integration.
Arena retains its player/competition observation composition, markers, browser
capture integration and action policy. Consumers can reuse the captured data in
additional bounded read-only perception queries without importing that policy.
