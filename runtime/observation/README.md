# Observation functions

This directory reads the character's state without acting on it: one sample
of everything (`mf snapshot`), the radar, health and item events, the open
space around the character, reach maps and place graphs. Your programs call
these functions; the background modules in
[../default-scripts/](../default-scripts/) (danger, radar, explore, watchdog)
are built on them and write what they find to the log
([../README.md](../README.md#the-log)). Paths below are under
`$MF_TOOLKIT_ROOT/runtime`.

`null` or `known: false` means no data, not empty; `unknown` blocks are not
air.

## One sample on request: `mf snapshot`

`mf snapshot` prints one full sample now, `{state, metadata}`, straight from the bot. `--full-items` adds item components, `--full-entities` every entity with raw metadata (instead of 12), `--full-local` the whole local cube and every loaded sign. Besides `self`, `inventory`, `equipment`, `heldItem`, `cursor`, `window` and `radar` it has `freshness`, `players` (every known player), `entities` (counts and up to 12 entries, risk signs first), `radar.excluded` (what the radar left out: outside the radius, blocked, unknown visibility) and `local`: `around` (what walking 3 blocks north, east, south and west meets, such as `flat 3+`, `wall 3 high`, `drop 9 (fall damage)`, `water`), `above` (head room) and notable blocks within 2 blocks.

## Radar

- Non-player entities within 48 blocks whose center you can see (a straight line through known, transparent blocks), summarized per chunk column in `entityChunks`: `chunk` (`x = floor(blockX / 16)`, same for `z`), `counts` (name → number), `nearest` (blocks).
- Players within 64 blocks: one known not to sneak is listed through walls (its name tag shows) with `visibility: "name-tag"`; a sneaking one only when visible. Players carry `team` and `relation` (`ally`, `opponent`, `unknown`) from the session's public teams.
- `named`: other entities within 64 blocks whose name always shows (a named mob or armor stand), with `customName`.
- `drops`: item drops grouped within 3 blocks: `center`, `items` (name → count), `count`.
- `alerts`: visible entities within 16 blocks with a risk sign (lit TNT, a swelling creeper, a moving projectile, something targeting you), with `id`, `name`, `position`, `distance`, `reasons`.

For exact positions use `mf snapshot --full-entities`, or `entityRadar(bot, { entities: "list" })`.

## Events

`watchObservation` (what the danger module uses) reports these:

| Event | When | Priority |
| --- | --- | --- |
| `health_loss` | health dropped (drops within 250 ms merged, with their source) | normal; **urgent** when heavy: 4 health within 2 s, or 3 drops adding up to 3 |
| `hurt` | a hit with no measurable health drop | normal |
| `critical_health` | health entered 0 < health ≤ 6 (again only after reaching 8) | **urgent** |
| `spawn` / `respawn` | the character spawned (`initial` marks the first) | normal |
| `stale` / `restored` | data older than 5 s / fresh again | normal |
| `inventory_transition` | out of food, ammunition or solid blocks, or lost an equipped or held item | normal |
| `objective_inventory` | your count of one of your team's public goal blocks (`briefing.public.goals`) went from 0 to positive or back | normal |
| `inventory_watch` | your count of an item in `briefing.public.watchItems` went from 0 to positive or back | normal |

Events only report; they never stop programs. Item events state what was seen, not that a goal is done.

## Background watchdog

`default-scripts/watchdog.mjs` watches from outside your programs ([trend-watch.mjs](trend-watch.mjs)). Each finding needs minutes of evidence and is logged once until the situation changes:

| Finding | When | Priority |
| --- | --- | --- |
| `no_progress` | 5 minutes within 6 blocks, no new chunk, inventory unchanged, nothing dug | normal |
| `circling` | in 3 minutes, 80 blocks walked over at most 12 distinct 2×2 cells | normal |
| `against_wall` | a movement key held against a wall for 20 s | normal |
| `repeat_dig` | the same block dug 3 times within 10 minutes | normal |
| `repeat_chat` | the same own chat message 3 times within 10 minutes | normal |
| `repeat_death` | 2 deaths within 16 blocks of each other within 10 minutes | **urgent** |

The watchdog every controlling program gets (see the main README) is stricter and sees what the program is trying to do.

## Functions

All read only; import them from `$MF_TOOLKIT_ROOT/runtime/observation/` inside a module.

| Function | File | Use |
| --- | --- | --- |
| `sampleObservation(bot, options)` | `index.mjs` | one synchronous sample, the shape of `mf snapshot`'s `state` |
| `observe(bot, options)` | `observe.mjs` | `{state, metadata}`, what `mf snapshot` prints |
| `entityRadar(bot, {radius, nameRadius, dropGroupRadius, entities})` | `index.mjs` | the `radar` section alone |
| `watchObservation(bot, {post, ...thresholds})` | `index.mjs` | the event listeners (table above); `sample()`, `close()`. It reports `death` and `disconnected` (urgent) too, unless `lifecycleEvents: false` (the danger module's setting: the runtime logs those as stops) |
| `queryTreeCandidate({blockAt, seed})` | `queries.mjs` | the logs, leaf evidence and unknown edges of one tree |
| `queryEntitiesIntersecting({entities, bounds})` | `queries.mjs` | entities whose box overlaps `bounds`, before placing a block |
| `reachMap`, `reachGraph`, `terrainProfile`, `aroundSummary` | `reach.mjs` | where Pathfinder can take you and back (a north-up grid), the walkable surface along a line |
| `findLink`, `placeGraph`, `parseWaypoints` | `place-graph.mjs` | links between named places with Pathfinder's own search; nothing moves |
| `sampleNearbyConnectedBlocks({blockAt, origin, radius})` | `nearby-connected-blocks.mjs` | the open space around a cell and the blocks and signs at its edge (what the explore module scans) |
| `createTrendWatch(thresholds)` | `trend-watch.mjs` | the background watchdog's findings from samples you feed it |

`sampleObservation` options: `fullItems`, `fullEntities`, `fullLocal`, `local`, `loadedSigns`, `radar`, `localRadius` (2), `blockLimit` (16), `signLimit` (16), `entityLimit` (12), `entityRadius`, `entityAttentionRadius` (16), `staleAfterMs` (5000), `teams`. `watchObservation` thresholds: `healthBurstMs` (250), `criticalHealth` (6), `criticalHysteresis` (2), `damageWindowMs` (2000), `urgentDamageLoss` (4), `sustainedDamageEvents` (3), `sustainedDamageLoss` (3), `damageCooldownMs` (5000), `damageRecovery` (2), `objectiveItems`, `inventoryWatchItems`.

The reach functions take `blockAt(position)` (a live bot's, a block-memory view's, or your own) and Pathfinder `Movements` settings: `radius` 12, `steps` 24, `canDig` false, `allowParkour` true, `allowSprinting` true, `blocks` 0 (no bridging or towering), `allow1by1towers` true, `maxDropDown` 4, `canOpenDoors` false. In `reachMap`'s grid, digits are feet height (`4` is the start's), `@` start, `T` target, `~` water, `x`/`X` wall under / at least 4 high, `O` deep drop, `v` one-way, `·` not reached, `!` lava or fire, `?` not received, `<` `>` a floor not drawn.

## Limits

The modules sample every second or two, so a shorter change can be missed; events are seen only while a module watches; radar sees 48 blocks (entities) and 64 (players and shown names) by the center line only; the explore scan reaches 6 blocks. Everything comes from what the character has received: areas it has not loaded are `unknown`.

## Files

`snapshot.mjs` (samples and sections), `entity-radar.mjs`, `events.mjs`, `nearby-connected-blocks.mjs` (the open-space scan and signs), `session-options.mjs` (teams and goal items from the public session), `observe.mjs`, `queries.mjs`, `reach.mjs`, `place-graph.mjs`, `trend-watch.mjs`.
