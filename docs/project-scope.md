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

Repository name: `mineflayer-agent-tools` (renamed from `mineflayer-world-memory`).
The package/import name stays `mineflayer-world-memory` for now, for backward
compatibility: renaming the GitHub repository does not rename the Node package
or rewrite consumer imports. Consumers depend on a commit tarball
(`codeload.github.com/ueagohbbcd/mineflayer-agent-tools/tar.gz/<commit>`) under
the dependency key `mineflayer-world-memory`. Changing the package name is a
later, separate breaking change.

## Division of work with Craft Arena

- This repository ships libraries, small proven tools, prompts and guides. The
  guides will be packed into one main skill for "drop into any agent and play
  Minecraft", including short Mineflayer install/join notes; unit guides stay as
  references inside it, not as separately installed skills.
- Craft Arena depends on the libraries only, through a pinned commit tarball. It
  does not install this repository's skills: it copies the parts it needs and
  rewrites them as its own smaller skills for the match rules.
- Libraries never import an inbox, match clock or arena session. Reporting goes
  through a callback or object the caller passes in (for example
  `watchdog(bot, { report })`).
