# mf: a step-by-step runtime for Mineflayer agents

`mf` lets an agent that only has a shell play through a real Mineflayer bot.
The agent writes a module, runs it with `mf run`, and gets one result back:
what the module printed, how it ended, and every report (state changes,
damage, deaths, chat, watchdog findings) since the previous result. Then it
thinks and runs the next module. Nothing has to wake the agent, and the agent
never has to keep track of time.

## Quick start

```sh
export MF_USERNAME=Steve ARENA_MINECRAFT_HOST=localhost   # ARENA_MINECRAFT_PORT, MC_VERSION optional
npx mf start                       # supervisor + the character, in the background
cat > look.mjs <<'EOF'
export default async function (bot, { log }) {
  log(bot.entity.position, bot.health, bot.food);
}
EOF
npx mf run look.mjs
```

State lives in `./.mf` (or `MF_STATE_DIR`): sockets, `supervisor.log`, and
one directory per program with `stdout.log`, `stderr.log` and `status.json`.

## Commands

| Command | What it does |
| --- | --- |
| `mf start` / `mf stop` | Start or stop the supervisor and the character(s) |
| `mf run [--wait S] [--stall S] [--bot NAME] [--background] FILE [ARGS]` | Run a module and wait for its result |
| `mf wait [--wait S] [--stall S] TASK_ID` | Keep waiting on a program that is still running |
| `mf cancel TASK_ID` | Stop a program |
| `mf events` | Only the reports since the last result |
| `mf status` | Characters and running programs (JSON) |
| `mf snapshot [--full-entities] [--full-local] [--full-items]` | One full state sample (JSON) |

## A step

`mf run` returns one of four results, on the first line:

| Result | When |
| --- | --- |
| `completed` | The module returned (its return value is printed as JSON) or threw (`exit 1`, error in stderr). |
| `running` | The module is still running: `--wait` seconds passed (default 30; `0` returns at once), it made no progress for `--stall` seconds (default 60: nothing printed, the character did not move and its inventory did not change), or an urgent report needs your attention (low health, a large hit, a chat mention, `requestJudgment`). Use `mf wait TASK_ID` to keep waiting, or run something else. |
| `interrupted` | The module was stopped because its plan no longer holds: the character died or disconnected, its process was blocked by a synchronous loop, or a new program replaced it. |
| `not_started` | The character died, disconnected or its process crashed since your last result. The module was not run; read the reports and decide again. |

`--wait` is your estimate of how long the program needs; output printed so far
comes back with `running`, and the full output is in the log directory.

## One controlling program

A module controls the character unless it says otherwise. Starting a new one
first stops the current one and waits until it has let go of the bot (a module
that ignores its abort signal gets its character process restarted). A
read-only module, marked with `export const control = false` in the module or
`--background` on the command line, runs beside the controller, is never
interrupted, and never stops the character's movement when it ends.

## Between programs: idle

When no program controls the character, the supervisor runs an idle module:
it fights hostile mobs within 3.5 blocks (with the best sword or axe), eats
below 14 food and holds jump in water. It never sets a Pathfinder goal or
chases. What it did comes back as an `idle.summary` report.

Put your own `idle.mjs` in the working directory to replace it. It is loaded
fresh each time the character becomes idle. If it fails, the built-in one
runs instead (with an `idle.failed` report) until you change the file.
`MF_IDLE=off` turns idle off.

## Modules

```js
export default async function (bot, { signal, args, log }) {
  // bot is the real Mineflayer bot; load plugins as usual (once per bot).
  // signal aborts when the program is cancelled, replaced or interrupted.
  // log(...) prints into this program's output (console.log works too).
  return { anything: "JSON-serializable" };
}
```

Listeners and timers a module adds are removed when it ends. When a
controlling module is cancelled or throws, the character releases its keys and
Pathfinder/PvP stop.

Programs import the toolkit through `MF_TOOLKIT_ROOT` (set for every program),
for example the watchdog that reports into the same queue:

```js
const { watchdog } = await import(`${process.env.MF_TOOLKIT_ROOT}/runtime/observation/watchdog.mjs`);
const dog = watchdog(bot); // stuck and repeat: reports; a blocked loop: interrupts this program
```

Programs report with `InboxClient` (`runtime/inbox/index.mjs`): `post(data)`,
`upsert(key, data)` (a replaceable state), `requestJudgment(data)` (urgent).

## Default background scripts

Started with the supervisor, restarted with the character: `observer` (state
and change reports; tune with `observer.json` in the working directory),
`chat` (chat lines; `ARENA_CHAT_WAKE=mention|all` makes them urgent) and
`watchdog` (long-term trends: no progress for minutes, circling, repeated
deaths). `MF_DEFAULT_SCRIPTS` lists which to start (default
`observer,chat,watchdog`).

## Processes

- `supervisor.mjs`: the report queue, programs and their logs, the character
  processes (restarted when they exit), idle, and the control socket that `mf`
  talks to. It never touches the bot, so it keeps working while a character's
  process is blocked.
- `host/cli.mjs`: one per character; owns the Mineflayer bot and runs modules
  in its own event loop (`host/runner.mjs`).
- `host/run.mjs`: runs one module on a character and streams its output.

Several characters: `MF_USERNAMES=a,b`; pick one with `--bot NAME`.
