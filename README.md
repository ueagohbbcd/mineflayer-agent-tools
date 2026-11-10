# Mineflayer Agent Tools

A toolkit that lets an agent with a shell play Minecraft Java through a real
Mineflayer bot. Its centre is [`game/`](game/README.md): one Node process holds
the bot, runs the task files the agent writes, and reports back what happened.
Underneath are passive libraries it builds on: chunk history, bounded
perception queries, pictures of the world and a watchdog.

## Let an agent play

1. Copy [`game/template/`](game/template/) into a project that has this package
   installed, and set `MF_HOST`, `MF_PORT`, `MF_USERNAME` as needed.
2. Start `node main.mjs` in the background; it holds the bot.
3. The agent drives it with `node game.mjs run|wait|cancel|query|status|stop`
   (`run` follows a job to its end; `wait` returns with a report once something
   happened) and reads the recorders with `node report.mjs`.
4. The agent's page is [`game/template/AGENTS.md`](game/template/AGENTS.md),
   copied with the template. For subject knowledge give it the skills in
   [`skills/`](skills/), [`mineflayer-game`](skills/mineflayer-game/SKILL.md)
   first, or the one-skill bundle
   [`bundle/mineflayer-agent`](bundle/mineflayer-agent/SKILL.md) built from them.

## Work on the repository

- [AGENTS.md](AGENTS.md): layers, vocabulary, document map, writing rules, checks.
- [docs/architecture.md](docs/architecture.md): what runs at play time and what
  each place does; read first.
- [docs/principles.md](docs/principles.md) and [docs/lessons.md](docs/lessons.md):
  why the toolkit is shaped this way, and the observations behind it.
- [docs/self-iteration.md](docs/self-iteration.md): how play feeds back into the
  repository.
- [docs/project-scope.md](docs/project-scope.md): what belongs here and what
  stays outside.
- Checks: `npm test`; `npm run test:visual` for the Python renderers; game
  behaviour on a local server with [`game/dev/`](game/dev/SCENARIOS.md).

## Use the libraries alone

[docs/libraries/](docs/libraries/README.md) indexes the manuals: world memory,
offline and live pictures, perception queries and the watchdog, plus the example
programs and their tests.

## Install

- Package name: `mineflayer-world-memory`; repository:
  `ueagohbbcd/mineflayer-agent-tools`.
- Installed from a GitHub tarball pinned to a commit; there is no npm release:

  ```json
  "dependencies": {
    "mineflayer-world-memory": "https://codeload.github.com/ueagohbbcd/mineflayer-agent-tools/tar.gz/<commit>"
  }
  ```

- Node 22 or newer. Mineflayer and its plugins are peer dependencies.
