# mf: a shell runtime for Mineflayer agents

`mf` lets an agent that only has a shell play through a real Mineflayer bot.
The character stays connected in its own process; the agent writes ordinary
async JavaScript modules and runs them on it with `mf run`. Programs and the
default observers keep running while the model thinks.

`mf` does not schedule the model. Running a program in the background,
telling the model when it ended, and showing its output are the harness's
job: use your tool's background shell for long programs, and `mf inbox` to
read what happened in the game.

## Quick start

```sh
export MF_USERNAME=Steve MF_HOST=localhost   # MF_PORT (25565) and MC_VERSION (1.21.1) optional
npx mf start                       # supervisor + the character, in the background
cat > look.mjs <<'EOF'
export default async function (bot) {
  return { at: bot.entity.position, health: bot.health, food: bot.food };
}
EOF
npx mf run look.mjs
```

Node 22 or newer. State lives in `./.mf` (or `MF_STATE_DIR`), so run `mf`
from the directory where you started it: sockets, `supervisor.log`, and
`tasks/<taskId>/` with `stdout.log`, `stderr.log` and `status.json` for each
program (the newest 100 are kept across restarts; idle and snapshots leave
none).

## Commands

| Command                                                              | What it does                                                                               |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `mf start` / `mf stop`                                               | Start or stop the supervisor and the character(s)                                          |
| `mf run [--bot NAME] [--inbox S] [--read-only] [--keep] FILE [ARGS]` | Run a module until it ends; its output appears as it is printed                            |
| `mf inbox [--again]`                                                 | The reports and stops since you last read it, at once (`--again` shows that batch again)   |
| `mf status`                                                          | Characters, programs, idle, and what programs set with `setStatus` (JSON)                  |
| `mf cancel TASK_ID`                                                  | Stop a program                                                                             |
| `mf idle on\|off [--bot NAME]`                                       | Turn the behaviour between programs on or off                                              |
| `mf snapshot [--full-entities] [--full-local] [--full-items]`        | One full state sample (JSON)                                                               |

## How to use it

- **Long programs in the background.** Start `mf run walk.mjs …` with your
  tool's background shell. You get on with other work; the harness tells you
  when it ends, and the background job's output has the program's own lines
  and how it ended.
- **Look at the game in the foreground.** `mf inbox` returns at once with
  what was reported since you last read it: damage, chat, deaths, what the
  observer saw. Only `mf inbox`, and `mf run --inbox S` when the program
  ends within S seconds, take reports out of the queue.
  Read it before deciding something that depends on the game; it can go
  beside a background `mf run` in the same batch of tool calls.
- **Programs you wait for.** Estimate how long the program needs and pass
  `--inbox S`, with S no longer than your tool waits for a command in the
  foreground (20 if you do not know it): `mf run --inbox 20 look.mjs`. If the program ends
  within S seconds, the inbox follows its result in the same output, as new
  as the result. If it runs longer, your tool has probably moved the command
  to the background, so `mf` leaves the inbox for you to read with
  `mf inbox`. (Two separate tool calls in one batch may run at the same
  time, so an `mf inbox` beside the run would be read before it ends.)
- **Ending `mf run` is not cancelling.** If the shell command is stopped or
  moved to the background, the program keeps running; its end then shows up
  in `mf inbox` as `task.completed`. Use `mf cancel TASK_ID` to stop it.
- **Logs.** `mf run` prints `[started] task=… logs=…` first. The log
  directory has the program's whole output.

Something written to a background job's output has not been seen until you
read it, and a harness may drop or delay its notification. That is why a
plain `mf run` never takes reports, and `mf run --inbox S` takes them only
when it prints them right after a program that ended within S seconds: in
every other case they stay in the inbox until you ask for them.
If an `mf inbox` output was lost or cut, `mf inbox --again` shows the last
batch again.

## Results

`mf run` prints the program's output as it comes, then one line saying how it
ended:

| Result        | When                                                                                                                    | Exit code |
| ------------- | ----------------------------------------------------------------------------------------------------------------------- | --------- |
| `completed`   | The module returned (its return value is printed as JSON) or threw (`exit 1`, error in stderr).                         | 0 or 1    |
| `interrupted` | The module was stopped: a stop for its character (below), a new program replaced it, or you ran `mf cancel`.            | 130       |
| `not_started` | A stop for this character that you have not read yet. The module was not run.                                           | 75        |

`not_started` names the character and the reason, and tells you to read
`mf inbox`; the details are there.

A **stop** ends the character's program and keeps the next one from
starting until you have read it, so that you decide again: the character
died, moved to another dimension, the session state changed, it
disconnected, its process crashed or stopped answering, or a watchdog found
a blocked loop. Stops come from the
character's process directly, so they hold whatever default scripts run. A
program or an adapter can add its own with `stop: "reason"` in a report's
data.

`mf inbox` lists stops first, as `! stop: REASON (CHARACTER)` lines. A stop
stays in force until `mf inbox` has shown it: after a death you have not read
about, `mf run` comes back `not_started` until you read the inbox; then it
runs.

`mf inbox` shows the reports that fit in 16000 bytes
(`MF_REPORT_BYTES`), urgent ones first; the rest wait for the next call. A
report counts as given once `mf` has printed it: if `mf` is killed before, it
comes again. Keep the budget below what your harness shows of one command.

## One controlling program

A module controls the character unless it says otherwise. Starting a new one
first stops the current one and waits until it has let go of the bot, then
starts the new one. A read-only module, marked with
`export const control = false` in the module or `--read-only` on the command
line, runs beside the controller and never stops the character's movement.
`--keep` starts a read-only module that keeps running and restarts with its
character (like the default scripts); `mf` returns once it has started.

When a controlling module ends, however it ends, the character releases its
movement keys and stops Pathfinder and PvP. A module that sets a goal and
returns does not leave the character walking: wait for the walk inside the
module. Cancelling is cooperative (the module's `signal` aborts); a module
that keeps running after that gets its character's process restarted, which
is the only way to stop code that does not cooperate.

Several `mf run` calls for the same character in one batch of parallel tool
calls race: the last to arrive is the one that keeps running. Put at most one
controlling program per character in a batch; `mf inbox`, `mf status` and
read-only modules can go beside it.

## Modules

```js
export default async function (bot, { signal, args, log }) {
  // bot is the real Mineflayer bot; load plugins as usual (once per bot).
  // signal aborts when the program is cancelled, replaced or interrupted.
  // log(...) prints into this program's output (console.log works too).
  return { anything: "JSON-serializable" };
}
```

The function ending is the program ending. Listeners a module adds on `bot`
itself and timers it starts are removed when it ends; listeners on other
objects (`bot.inventory`, `bot._client`, a plugin) are yours to remove.
A module can import the packages installed with the toolkit (`vec3`,
`mineflayer-pathfinder` and so on) by name from any directory; a package
installed next to the module wins. Relative paths inside a module resolve
against the character's process, not your shell: build paths from `import.meta.url` or pass absolute ones. Each run
loads the module file fresh, but files it imports are cached until the
character restarts.

Programs import the toolkit through `MF_TOOLKIT_ROOT` (set for every program),
for example the watchdog that reports into the same queue:

```js
const { watchdog } = await import(
  `${process.env.MF_TOOLKIT_ROOT}/runtime/observation/watchdog.mjs`
);
const dog = watchdog(bot); // stuck and repeat: reports; a blocked loop: interrupts this program
```

Programs report with `InboxClient` (`runtime/inbox/index.mjs`): `post(data)`,
`upsert(key, data)` (a replaceable state), `setStatus(key, data)` (shown by
`mf status`), `requestJudgment(data)` (urgent: listed first). See
[inbox/README.md](inbox/README.md).

## Default modules

The default scripts and idle are ordinary modules with the same interface as
yours; "default" only means they are started for you.

- `observer` (state and change reports, see
  [observation/README.md](observation/README.md); tune with `observer.json`
  in the working directory), `chat` (other players' chat and whispers, and system
  lines such as "Respawn point set") and `watchdog` (long-term trends: no
  progress for minutes, circling, repeated deaths) run as kept read-only
  modules on every character. `MF_DEFAULT_SCRIPTS` lists which to start
  (default `observer,chat,watchdog`). Stop one with `mf cancel`; start it, or
  your own copy, with `mf run --keep FILE` (the files are in
  `$MF_TOOLKIT_ROOT/runtime/default-scripts/`).
- `idle` runs when no program controls the character: it fights hostile mobs
  within 3.5 blocks (with the best sword or axe), eats below 14 food and holds
  jump in water. It never sets a Pathfinder goal or chases. What it did comes
  back as an `idle.summary` report. Put your own `idle.mjs` in the working
  directory to replace it; it is loaded fresh each time the character becomes
  idle, and if it fails the built-in one runs instead (with an `idle.failed`
  report) until you change the file. `mf idle off` (or `MF_IDLE=off`, or
  cancelling the idle task) turns it off.

## Processes

- `supervisor.mjs`: the report queue, programs and their logs, the character
  processes (restarted when they exit), idle, and the control socket that `mf`
  talks to. It never touches the bot, so it keeps working while a character's
  process is blocked.
- `host/cli.mjs`: one per character; owns the Mineflayer bot and runs modules
  in its own event loop (`host/runner.mjs`).
- `host/run.mjs`: runs one module on a character and streams its output.

Several characters: `MF_USERNAMES=a,b`; pick one with `--bot NAME`. Each
character has its own process, default scripts, idle, controlling program and
changes: a program on one character never replaces or blocks another's.
Reports name their character; a report from a process of the character that
has since restarted says `before a restart`.

The supervisor keeps a connection to each character's process that carries a
heartbeat every second. A process silent for 20 s
(`MF_HOST_UNRESPONSIVE_SECONDS`; `0` turns this off), such as one stuck in a
synchronous loop, is killed and restarted, and its program is interrupted.

## Settings

| Variable                       | Default                  |                                                                           |
| ------------------------------ | ------------------------ | ------------------------------------------------------------------------- |
| `MF_USERNAME` / `MF_USERNAMES` | (required)               | Character name(s)                                                         |
| `MF_HOST`, `MF_PORT`           | (required), 25565        | Server (`ARENA_MINECRAFT_HOST`/`_PORT` still work)                        |
| `MC_VERSION`                   | 1.21.1                   | Game version                                                              |
| `MF_AUTH`, `MF_PROFILES_DIR`   | offline                  | `microsoft` logs in with an account; profiles are cached in the directory |
| `MF_STATE_DIR`                 | `./.mf`                  | State, sockets and logs                                                   |
| `MF_IDLE`                      | on                       | `off` starts with idle off                                                |
| `MF_DEFAULT_SCRIPTS`           | `observer,chat,watchdog` | Which default scripts run                                                 |
| `MF_REPORT_BYTES`              | 16000                    | How much report text one result shows                                     |
| `MF_HOST_UNRESPONSIVE_SECONDS` | 20                       | Restart a character's process after this long without a heartbeat         |

A character process that keeps exiting is restarted after 2 s, then later each
time, up to a minute.
