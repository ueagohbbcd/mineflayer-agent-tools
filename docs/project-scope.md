# Scope

What belongs in this repository and what stays outside. How it is built:
[architecture.md](architecture.md); why: [principles.md](principles.md).

## In this repository

- `game/`: the process that holds a real Mineflayer bot for any agent with a
  shell, its experimental control logic, and the player's template.
- Passive libraries (repository root, `lib/`, `renderers/`): chunk history,
  bounded queries, pictures, the watchdog ([libraries/](libraries/README.md)).
- Guides for playing agents: the skills in [`skills/`](../skills/) and the
  bundle built from them, [`bundle/mineflayer-agent`](../bundle/mineflayer-agent/SKILL.md).
  An agent takes either the bundle or the separate skills; a project composing
  its own main skill uses each skill's `intro.md` paragraph.
- Example programs (`examples/`).

Mineflayer's own world, `mineflayer-pathfinder` and the other plugins, and
`prismarine-viewer` keep their jobs; this repository wires them up.

## Outside this repository

Arena rules, teams, trusted messages and match scheduling. Libraries never
import `game/`, a match clock or an arena session; anything they report goes
through a callback the caller passes in (for example `watchdog(bot, { report })`).

## Messages from outside the game

Someone outside the game reaches the model in one of two ways, and both end in
the harness's own input:

- Direct: the person using the agent types to it through the harness (chat box,
  CLI prompt or RPC `prompt`); this needs nothing from this repository.
- Automated: a trusted system (a match server, an operator's script) turns its
  state into harness input through an adapter the caller writes, as Craft
  Arena's Pi extension does with its platform messages.

`game/` carries neither. Game chat is game data, whoever wrote it, and a notice
cannot carry trust because the model's own code writes notices too.

## Division of work with Craft Arena

Craft Arena installs this package from a commit tarball of
`ueagohbbcd/mineflayer-agent-tools` under the package name
`mineflayer-world-memory` and uses the libraries. It does not install the
skills: it copies the parts it needs into its own smaller skills for its match
rules.
