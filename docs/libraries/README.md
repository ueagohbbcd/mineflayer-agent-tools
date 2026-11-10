# Libraries

The libraries at the repository root, in `lib/` and in `renderers/` are passive helpers on a Mineflayer bot or its world. They never import `game/`, never notify a model, install no background loop, and take a callback for anything they report. `game/` builds on them; another project can use them alone.

Install the package from a GitHub tarball pinned to a commit (there is no npm release); the package and import name is `mineflayer-world-memory`:

```json
"dependencies": {
  "mineflayer-world-memory": "https://codeload.github.com/ueagohbbcd/mineflayer-agent-tools/tar.gz/<commit>"
}
```

## Manuals

| Manual | Covers | Entry |
| --- | --- | --- |
| [memory-api.md](memory-api.md) | Optional history of received chunks: recording, persistence, `summary()`, exposure, chunk heights, exact reads, lazy full-column readers, live-first `readWorldBlock` | `index.js` (`createWorldMemory`), `reader.js` / `reader.mjs` |
| [visual.md](visual.md) | Offline pictures of the cache: surface maps, regions, underground air casts, image sidecars, the `world-memory` CLI | `bin/world-memory.js`, `lib/visual.js` (`visual` export), `renderers/*.py` |
| [local-3d.md](local-3d.md) | Optional textured local 3D of an exported region with Prismarine-viewer models | `lib/local-mesh.js`, `renderers/local_texture.py` |
| [live-visual.md](live-visual.md) | CPU views of an already connected bot or local mirror, on request | `live.js` / `live.mjs` (`visual.live`), `lib/live-*.js` |
| [perception-queries.md](perception-queries.md) | Bounded on-demand queries; the tree-candidate query | `queries.js` / `queries.mjs`, `lib/tree-query.js` |
| [watchdog.md](watchdog.md) | A stuck bot, a program retrying the same thing, a program blocked by a synchronous loop | `watchdog.js` / `watchdog.mjs` |

Two shared rules run through all of them: unknown is never air, and every remembered observation carries its time so a caller can judge freshness. The live Mineflayer world (`bot.blockAt`, `bot.world`) is authoritative for the present; remembered chunks only fill in what is unloaded.

## Example programs

`examples/*.mjs` are short modules, each showing one way to do a task that the game's experimental code and plugins do not already show: reach maps and place graphs, terrain summaries, pictures, and a few read-only lookups. Agents read them, run them (`node game.mjs query <toolkit>/examples/reach-map.mjs`), import them from their own tasks, or copy and change them. Travelling is `game/experimental/goto.mjs`; fighting and eating are the reflexes in `game/experimental/reflexes.mjs`, backed by mineflayer-pvp and mineflayer-auto-eat. The examples need `vec3` installed beside this package. `examples/make-demo-cache.js` writes the synthetic cache used by the [visual demo](visual.md#start-with-the-synthetic-demo). Their tests are in `test/examples/`.

## Tests

```sh
npm test
python3 -m pip install -r renderers/requirements.txt  # explicit optional install
npm run test:visual
node benchmark/terrain.js
node benchmark/visual.js
```

Verification uses synthetic worlds and assets; behaviour on a live server is not verified by these tests. Blender rendering is a separate optional smoke test described in [visual.md](visual.md). The core Node installation needs no Python, Blender, browser or GPU.
