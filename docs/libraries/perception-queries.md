# On-demand perception queries

Call a local query to turn a selected log into candidate trunk/branch coordinates;
ordinary control code chooses which blocks to gather.

## Task index

- **Chopping a tree → `queryTreeCandidate`:** candidate logs, nearby leaves and
  boundary evidence from a caller-selected seed.
- **Check an exact cached block → `memory.block(...)`:** [memory API](memory-api.md).
- **Inspect local geometry → request a local image:** [visual workflow](visual.md).

Include this index or the query signature in your model's tool description so
it can discover the capability. Imports are passive; each explicit query call
reads only the bounded neighborhood supplied by your `blockAt` source.

## Shortest call

```js
import { queryTreeCandidate } from 'mineflayer-world-memory/queries.mjs'

const candidate = queryTreeCandidate({
  blockAt: position => bot.blockAt(position),
  seed: { x: 12, y: 64, z: -8 } // selected log, in block coordinates
})
console.log(candidate.logs) // [{ x, y, z, name }, ...]
```

CommonJS: `require('mineflayer-world-memory/queries')`.
The synchronous reader receives native `Vec3` positions. The wrapper above
preserves Mineflayer's bot context.

## Reading the result

- `status`: `candidate` means an observed connected log cluster; `not_a_log` and
  `unknown_seed` finish after the seed read.
- `logs`: candidate trunk and branch coordinates, in breadth-first discovery
  order. Matching uses `*_log`, including stripped logs; `minecraft:` is
  normalized. Wood blocks, planks, Nether stems/hyphae and roots are outside this
  query's material scope.
- `leafEvidence`: nearby `*_leaves` records, count, completeness and leaf
  persistence counts. Leaves provide supporting evidence; placed leaves,
  buildings and neighboring canopies can produce similar patterns.
- `uncertainty`: readable warnings for possible artificial structures, merged
  adjacent trees, mixed log names and incomplete evidence. This is qualitative
  evidence about a candidate cluster, rather than a whole-tree guarantee.
- `unknownBoundaries`: unavailable cells, with `logs`/`leaves` phases. Null or
  `known: false` observations remain unknown; named air blocks are known empty
  space. `logTraversalComplete` and `leafEvidence.complete` distinguish which
  neighborhood was fully inspected.
- `truncated` / `truncationReasons`: a read, distance or log budget stopped
  inspection. Unknown boundaries are reported separately. `stats` counts actual
  block reads, known air and unknown cells; `bounds` and `limits` record the query.

Recheck freshness, reachability, ownership and game rules before gathering.
Choose an observation source allowed by your application: client-loaded data
may extend beyond camera visibility. World evidence comes entirely from that
source, with no private map data or assets. Timing, policy and actions belong to
ordinary caller JavaScript.

## Tunable parameters

| Parameter | Default | Meaning |
| --- | --- | --- |
| `seed` | required | Integer block coordinates of the selected log |
| `blockAt` | required | Synchronous observation reader, receiving `Vec3` |
| `connectivity` | `26` | Faces, edges and corners; `6` uses faces only |
| `includeMixedLogs` | `true` | Follow connected log names; false follows the seed's exact name |
| `maxLogs` | `256` | Positive maximum returned log count |
| `maxDistance` | `24` | Nonnegative inclusive Chebyshev radius from the seed |
| `maxReads` | `8192` | Positive total distinct block-read budget |
| `leafRadius` | `2` | Nonnegative Chebyshev radius around returned logs; zero skips leaf evidence |

Budgets are caller-adjustable integers with no additional fixed upper caps.
Log traversal runs first; leaf inspection shares its read and distance budgets.
Leaf neighborhoods are clipped to the query cube and traversed lazily.

The default 26-connectivity captures diagonal branches such as acacia. Choosing
6 reduces connections but can omit those branches; either choice can combine
touching trees. Synthetic oak, birch, diagonal acacia and large 2×2 spruce
fixtures cover these tradeoffs. Even complete local evidence leaves natural
origin and the boundary between adjacent trees uncertain.
