# Scope: Mineflayer agent utilities

This project is not a second Mineflayer, storage engine or pathfinder.

It has two layers. The libraries (repository root, `lib/`) are passive,
composable helpers: optional history of *received* chunks;
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

The runtime (`runtime/`, the `mf` command) lets any agent with a shell play
through a real Mineflayer bot: the bot processes, a report queue, programs
with logs, idle behaviour and default observers. Running programs in the
background and telling the model when they end is left to the harness
(see [runtime/README.md](../runtime/README.md)). It builds on the libraries;
the libraries never import it.

Inside the runtime, a small core does not depend on any replaceable part: the
character processes and their liveness, one controlling program per
character, cancellation and cleanup, and the record of what each result has
given the caller. The default scripts (observer, chat, trend watchdog), idle
and the routines in `examples/` are replaceable modules on top: turning one
off or replacing it must not change who controls a character, how a death
stops its program, or how a blocked process is recovered. Idle only acts
while no program controls the character; behaviour while a program runs
(defending on a walk, say) belongs in routines the model chooses to run.

Arena rules, teams, Pi, trusted messages and match scheduling remain outside
this repository.

## Messages from outside the game

Someone outside the game reaches the model in one of two ways, and both end
in the harness's own input:

- Direct: the person using the agent types to it through the harness (its chat
  box, CLI prompt or RPC `prompt`). This is the normal path when you play with
  the toolkit yourself on your own machine, and it needs nothing from this
  repository.
- Automated: a trusted system (a match server, an operator's script) turns its
  state into harness input through an adapter the caller writes, as Craft
  Arena's Pi extension does with its platform messages. That adapter belongs
  to the caller.

The runtime carries neither. Game chat is game data (`trusted: false`),
whoever wrote it. The report queue cannot carry trust either: its socket is
open to the model's own programs. Do not add a trusted-message path to `mf`.

Repository name: `mineflayer-agent-tools` (renamed from `mineflayer-world-memory`).
The package/import name stays `mineflayer-world-memory` for now, for backward
compatibility: renaming the GitHub repository does not rename the Node package
or rewrite consumer imports. Consumers depend on a commit tarball
(`codeload.github.com/ueagohbbcd/mineflayer-agent-tools/tar.gz/<commit>`) under
the dependency key `mineflayer-world-memory`. Changing the package name is a
later, separate breaking change.

## Division of work with Craft Arena

- This repository ships libraries, small proven tools, prompts and guides. The
  guides are packed into one main skill,
  [`skills/mineflayer-agent`](../skills/mineflayer-agent/SKILL.md), for "drop
  into any agent and play Minecraft", including short Mineflayer install/join
  notes; unit guides are references inside it, not separately installed skills.
- Craft Arena depends on the libraries only, through a pinned commit tarball. It
  does not install this repository's skills: it copies the parts it needs and
  rewrites them as its own smaller skills for the match rules.
- Craft Arena can use the runtime for its participants instead of keeping its
  own copy.
- Libraries never import an inbox, match clock or arena session. Reporting goes
  through a callback or object the caller passes in (for example
  `watchdog(bot, { report })`).
