# Developer guide

For contributors to this repository. Agents that play through it read `skills/mineflayer-agent/SKILL.md` and `runtime/README.md` instead.

## Two layers

- **Libraries** (repository root, `lib/`, `renderers/`): passive helpers on a bot or its world: optional history of received chunks, bounded queries, pictures, the watchdog. They never import `runtime/`, never touch a report queue, and take a callback for anything they report.
- **Runtime** (`runtime/`, the `mf` command): character processes, one controlling program per character, the report queue (`mf inbox`), default modules, idle. Telling a model when a background command ends is the harness's job, not the runtime's.

Scope and what not to build: [docs/project-scope.md](docs/project-scope.md).

## Who consumes it

craft-arena installs this package (name `mineflayer-world-memory`) from a codeload tarball of a commit and runs `runtime/supervisor.mjs` for its characters; its participant image drops `skills/`. A change here reaches the arena only when the arena bumps that commit, so run the arena's tests and `npm run verify:server` against a new commit before calling it done.

## Checks

```sh
npm test              # unit and fixture tests (Node 22+)
npm run test:visual   # renderer tests (Python, renderers/requirements.txt)
```

Runtime behaviour that unit tests cannot show (joining, deaths, real chat events) needs a local Minecraft 1.21.1 server; say so when it was not run instead of writing a test that pretends to cover it.
