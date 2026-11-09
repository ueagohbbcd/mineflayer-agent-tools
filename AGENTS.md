# Developer guide

For contributors to this repository. Agents that play through it read `game/template/AGENTS.md` (copied into their project), `skills/mineflayer-game/SKILL.md` (then the `mineflayer-*` skills it lists), or the bundle `bundle/mineflayer-agent/SKILL.md`. After changing a skill, run `npm run build:bundle`.

## Two layers

- **Libraries** (repository root, `lib/`, `renderers/`): passive helpers on a bot or its world: optional history of received chunks, bounded queries, pictures, the watchdog. They never import `game/`, never notify a model, and take a callback for anything they report.
- **Game** (`game/`): one process that holds the bot (`template/main.mjs`). The core (`lib/host.mjs`, `lib/server.mjs`) is kept small and game-agnostic: run task files, hand control between task, service and idle through one exit flow, a Unix socket for run/cancel/wait/query/status, a wake flag, and report functions joined when `wait` returns. A task that does not exit keeps the bot; the fallback is restarting the process, never wrapping the bot. Plugin quirks live in `game/lib/plugins.mjs`. The player's page is `game/template/AGENTS.md`; it is the one source of the task contract, and `npm run build:bundle` copies it into `skills/mineflayer-game/SKILL.md`. Telling a model when a background command ends is the harness's job.
- **Candidates** (`game/candidates/`): control logic found useful in tests or play (services, idle, danger takeover, `goto`, `craftChecked`). It stays there, marked in its README with what was checked on a server, until it has earned a place as a routine. Lessons for playing go into skills more freely.

Example programs (`examples/*.mjs`) sit on top of both: short task/query modules that each show one way to do a task, for agents to read, run or copy. They are teaching material, so keep each one to one technique. One way per thing: a second way enters only with server evidence that it is better for some case. Their tests are in `test/examples/`.

Scope and what not to build: [docs/project-scope.md](docs/project-scope.md).

## Document map

Each kind of text has one job. Write a thing once, in the place that owns it, and link to it from elsewhere.

| Text | Job | Read by |
| --- | --- | --- |
| [docs/principles.md](docs/principles.md) | Why the toolkit is shaped this way; read before changing a design, update when a trade-off is decided | contributors |
| [docs/lessons.md](docs/lessons.md) | What was observed, the evidence, what is done about it; open questions at the end | contributors |
| [docs/project-scope.md](docs/project-scope.md) | What belongs in this repository and what stays outside | contributors |
| This file | How to work on the repository: layers, document map, checks | contributors |
| [game/README.md](game/README.md) | How the game process is built: files, conventions, tests | contributors |
| [game/candidates/README.md](game/candidates/README.md) | Each candidate and its server record (scenario, result, how many runs) | contributors, playing agents |
| Module READMEs and `docs/*.md` for the libraries | One module each: what it does, how to call it, where its data lives, limits | contributors, playing agents |
| [game/template/AGENTS.md](game/template/AGENTS.md) | The player's one page: work loop, task contract, commands, one-line reminders | playing agents, always in context |
| `skills/*/SKILL.md` | Subject knowledge an agent looks up for what it is doing now | playing agents, on demand |
| `notes/` in a player project | That world's goal, places, structures, attempts | the playing agent itself |

Where a new piece of knowledge goes:

- A one-line reminder for play ("before X, check Y") → `game/template/AGENTS.md`.
- Subject knowledge with real body (several steps, code, a tool) → the skill of that subject.
- Something a plugin or Minecraft version does unexpectedly → a comment at the fix, a row in the candidates record if it was seen on a server, and an entry in `docs/lessons.md`.
- A decided trade-off → `docs/principles.md`; the observation behind it → `docs/lessons.md`.
- A server check → the record table next to the code, with the number of runs.
- Something still undecided → the open list at the end of `docs/lessons.md`.

Writing rules: state what is decided, in the present tense; write only about what the reader can see in the repository; say "not verified" or "not reproduced" where that is the case.

## Who consumes it

craft-arena installs this package (name `mineflayer-world-memory`) from a codeload tarball of a commit (pinned to a commit from before `game/`, which still has `runtime/`); its participant image drops `skills/` but keeps `examples/`, which its own skills point to. The arena also installs the dependencies its images need for parts of this package (for example the renderer's), since participant containers have no network. A change here reaches the arena only when the arena bumps that commit, so run the arena's tests and `npm run verify:server` against a new commit before calling it done.

## Checks

```sh
npm test              # unit and fixture tests (Node 22+)
npm run test:visual   # renderer tests (Python, renderers/requirements.txt)
```

Game behaviour that unit tests cannot show (joining, deaths, real chat events) needs a local Minecraft 1.21.1 server (`game/dev/`: RCON, course setup, test tasks); say so when it was not run instead of writing a test that pretends to cover it.
