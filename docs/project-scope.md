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

`game/` lets any agent with a shell play through a real Mineflayer bot: one
process (`main.mjs`, edited by the agent) holds the bot; tasks and read-only
queries are submitted to it through a local socket; one rule table runs in
three periods (inside the prebuilt `steps` loop it can take over a tick; while
a plugin or native code owns the bot it only notifies; between tasks it keeps
the character alive, with main's `idle`); observers write `records/`;
`notifyModel` + `wait` bring the model back. Running commands in the
background and telling the model when they end is left to the harness. It
builds on the libraries; the libraries never import it.

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

`game/` carries neither. Game chat is game data, whoever wrote it. Notices
cannot carry trust either: the model's own code writes them too. Do not add a
trusted-message path to `game/`.

Repository name: `mineflayer-agent-tools` (renamed from `mineflayer-world-memory`).
The package/import name stays `mineflayer-world-memory` for now, for backward
compatibility: renaming the GitHub repository does not rename the Node package
or rewrite consumer imports. Consumers depend on a commit tarball
(`codeload.github.com/ueagohbbcd/mineflayer-agent-tools/tar.gz/<commit>`) under
the dependency key `mineflayer-world-memory`. Changing the package name is a
later, separate breaking change.

## Division of work with Craft Arena

- This repository ships libraries, small proven tools, prompts and guides. The
  guides are a set of skills in [`skills/`](../skills/) to drop into any agent
  together: [`mf-basics`](../skills/mf-basics/SKILL.md) is the top one (running
  the character and programs with `mf`, the log, the work loop, the examples)
  and the peer `mineflayer-*` skills each cover one subject (programs and
  setup without `mf`, navigation, surroundings, items, survival). Background
  modules get a line in `mf-basics` and in the skill of their subject.
- One bundle skill, [`bundle/mineflayer-agent`](../bundle/mineflayer-agent/SKILL.md),
  holds all of them for an agent that should get only one: `mf-basics` is its
  SKILL.md, the others are its references, and each skill's `intro.md` is its
  paragraph there. `scripts/build-bundle.mjs` (`npm run build:bundle`) writes
  it and a test checks it matches. Take either the bundle or the separate
  skills, not both; to compose your own main skill, use the `intro.md`
  paragraphs.
- Craft Arena depends on the libraries only, through a pinned commit tarball. It
  does not install this repository's skills: it copies the parts it needs and
  rewrites them as its own smaller skills for the match rules.
- Libraries never import `game/`, a match clock or an arena session. Reporting goes
  through a callback or object the caller passes in (for example
  `watchdog(bot, { report })`).
