# Scope: Mineflayer agent utilities

This project is not a second Mineflayer, storage engine, pathfinder, or agent runtime.

Own only passive, composable helpers: optional history of *received* chunks;
bounded perception / spatial queries; read-only visual inspection; generic
watchdogs with caller-owned reporting. Preserve unknown vs known air and
freshness/timestamp metadata.

Prefer native Mineflayer `bot.blockAt` and `bot.world` for live data,
`mineflayer-pathfinder` for navigation, and `prismarine-viewer` for
supported textured rendering.

The existing JSON/gzip chunk persistence is legacy. Before adding new features,
evaluate `prismarine-world` and the Prismarine storage providers. Any migration
must explicitly handle older saved files, dimension/version separation,
timestamps, and the async-storage vs synchronous-query contract.

Arena rules, teams, Pi, Inbox, scheduling, trusted messages and bot RPC remain
outside this library.

Repository rename target: `mineflayer-agent-tools`.
Keep the package/import name `mineflayer-world-memory` temporarily for
backward compatibility; GitHub repository renaming does not automatically
rename Node packages or rewrite consumer imports.
