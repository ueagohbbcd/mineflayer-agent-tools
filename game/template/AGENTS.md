# Playing through main.mjs

`main.mjs` holds the character for as long as it runs. You write tasks (JavaScript modules in `tasks/`), hand them to it, and read what happened. You cannot see the game: you know only what reports, queries and pictures show you. `<toolkit>` means `node_modules/mineflayer-world-memory`.

## The job loop

1. Start `node main.mjs` once, in the background. A second start in the same directory only says one is running.
2. Submit a job in the background: `node game.mjs run tasks/x.mjs [args...]`. It prints the task's log lines and ends with the result when the job ends.
3. Run `node game.mjs wait`. It returns with a report as soon as something happens (a job ended, death, a reflex preempted the task, a whisper or your name in chat), at once if something already happened.
4. Read the report every time, even when `run` already printed the result: it also has health, food, time until night, inventory changes, who is around and what hurt you. Then decide and submit the next job.

Killing the `run` command only stops its output; the job goes on. `node game.mjs cancel` ends it. A new job replaces the running one.

## The task contract

```js
import { walkTo } from "mineflayer-world-memory/game/experimental/walk-to.mjs";

export default async function task(bot, ctx) {
  const [x, y, z] = ctx.args.map(Number); // the words after the file name
  ctx.log("on my way");                   // a line in the run output and the result
  await walkTo(bot, ctx, [x, y, z]);       // toolkit functions stop by themselves
  if (ctx.signal.aborted) return;          // the exit rule, after your own awaits
  return bot.entity.position.floored();    // the result
}
```

- `ctx.args`, `ctx.log`, `ctx.signal` are all a task needs. `tasks/example.mjs` is a complete one.
- **The one exit rule: after an await, if `ctx.signal.aborted`, return.** The signal aborts on cancel, a new job, a preempt and death; main then stops Pathfinder, fighting, digging, eating and open windows. A task that only calls toolkit functions (`walkTo`, `craftAndCount`) needs no exit code at all.
- The return value is the result; a thrown error is the failure, with its message.
- A task that keeps going after the abort keeps the character: nothing else starts, and `wait` tells you main needs a restart.

## What ends a job without you asking

- **Death.** The job ends; idle starts after respawn. The report has where you died and where you respawned.
- **A reflex preempts it.** A hostile mob hurting you below 12 health starts the `fightOrFlee` reflex; your head stuck in a block starts `digHeadFree`; running out of air under water starts `surfaceForAir`. The job ends with the reflex's result.

Either way, read the report, decide, and submit again. Nothing restarts by itself.

## Between jobs

Idle (`stayAlive` in main) keeps the character alive: it fights back when hit, gets its head out of blocks, stays at the water surface and eats when hungry. It does not travel or gather.

## Routines you can call or copy

Examples that worked in tests, in `<toolkit>/game/experimental/`; each source says what was checked and its limits. Not the only way: copy one into `tasks/` and change it. Each file also runs as a job, e.g. `node game.mjs run <toolkit>/game/experimental/dig-nearby.mjs iron_ore 5 16 dig`.

- `digNearby` (`dig-nearby.mjs`): gather blocks near you, bounded and skipping what fails; use it instead of collectBlock.
- `placeNear` (`place-near.mjs`): put a table, furnace or block down next to you, also in a 1-wide pit; notes it in `notes/places.md`.
- `smeltItems` (`smelt-items.mjs`), `craftAndCount` (`craft-and-count.mjs`): smelt and craft, placing a furnace or table when none is in reach.
- `equipArmour` (`equip-armour.mjs`): put on the best armour you carry; crafted armour is not worn by itself.
- `climbToSurface` (`climb-to-surface.mjs`): dig stairs up to open sky; safe to run again after a stop.
- `sealIn` (`seal-in.mjs`): wall yourself in for the night; says how to get out.
- `walkTo` (`walk-to.mjs`): walk to a spot. Query `<toolkit>/game/queries/find-blocks.mjs NAME[,NAME] [count]`: the nearest blocks.

## Commands

| Command | Does |
| --- | --- |
| `node game.mjs run <file> [args]` | submit a job, follow it to the end |
| `node game.mjs wait` | return with the report once something happened |
| `node game.mjs cancel` | end the current job |
| `node game.mjs query <file> [args]` | run a read-only module now, even during a job (10 s; `GAME_QUERY_TIMEOUT`) |
| `node game.mjs status` | who controls the character, the current job |
| `node game.mjs stop` | end main (start it again in the background) |
| `node report.mjs [name] [minutes]` | what the recorders kept (`explore`, `radar`); reads files only |
| `node report.mjs review` | what happened in this game so far, from the journal: deaths, jobs, preempts |

## Where to look

In this order, as far as you need:

1. The `wait` report.
2. A full sample now: `node game.mjs query <toolkit>/game/queries/snapshot.mjs` (you, inventory, entities, the four directions).
3. A query of your own for exact facts, e.g. `export default async (bot) => bot.blockAt(bot.entity.position.offset(0, -1, 0))?.name`. Check the target cell right before you act.
4. A map or a picture: `<toolkit>/examples/reach-map.mjs` (where you can walk), `<toolkit>/examples/screenshot.mjs` (a box from corners or above).

## Reminders

- Pathfinding walks only. After digging down, a job that walks back out fails with no path: run `climbToSurface`, or allow digging in that task's movements.
- Nothing stops a job when a tool breaks; the report's `upkeep` part says when one did or is about to. Carry a spare pickaxe when mining.
- If `wait` or `status` says main is not running, it crashed: start it again; the first `wait` then says which job was lost.
- After a death or a failed job, append one line to `notes/log.md`: what you were trying and what you will change.

## main.mjs is yours

Which reflexes, idle, reports and plugins it uses is plain code. After editing it, `node game.mjs stop` and start it again. Modules a task imports are cached until main restarts; edits to the task file itself apply on the next run.

## Notes for this world

Keep these in `notes/` and update them as you go. Mark each line as fact (seen or checked) or guess.

- Goal and progress
- Places, coordinates and how they connect
- Structures (what, where, bounding box)
- What was tried and how it went
- Tools written (tasks and queries in this project, what each does)
