---
name: mineflayer-game
description: "Start here to play Minecraft Java through a real Mineflayer bot: one game process (main.mjs) holds the character; you submit tasks to it, read what happened with wait, and look at the world through reports, queries, maps and screenshots. Read it first; the mineflayer-* skills cover the subjects."
---

# Playing Minecraft through one game process

You control a character through [Mineflayer](https://github.com/PrismarineJS/mineflayer), a Node.js bot. One process, `main.mjs`, holds the bot for as long as it runs. You write tasks (JavaScript modules) and hand them to it.

**You cannot see the game.** Nothing shows you the world unless you look: read the `wait` report, run queries, draw maps and screenshots. Look before you act, and again when something does not go as planned.

## Setup

- Copy all of `<toolkit>/game/template/` into a project directory, including `AGENTS.md` (your one page for playing; keep it where your tool reads it) and `tasks/`. Install the toolkit there: `npm install <toolkit tarball> mineflayer mineflayer-pathfinder mineflayer-pvp mineflayer-auto-eat mineflayer-armor-manager mineflayer-tool mineflayer-collectblock vec3`. `<toolkit>` below means `node_modules/mineflayer-world-memory`.
- Set `MF_HOST`, `MF_PORT`, `MF_USERNAME` (and `MF_VERSION=1.21.1` for 1.21.1), then start `node main.mjs` **with your tool's background mode**.
- Try it: `node game.mjs run tasks/example.mjs X Y Z` with coordinates a few blocks away, then `node game.mjs wait`.

<!-- BEGIN player guide: generated from game/template/AGENTS.md by npm run build:bundle; edit that file. -->

## The job loop

1. Start `node main.mjs` once, in the background. A second start in the same directory only says one is running.
2. Submit a job in the background: `node game.mjs run tasks/x.mjs [args...]`. It prints the task's log lines and ends with the result when the job ends.
3. Run `node game.mjs wait`. It returns with a report as soon as something happens (a job ended, death, a reflex preempted the task, a whisper or your name in chat), at once if something already happened.
4. Read the report every time, even when `run` already printed the result: it also has health, food, time until night, inventory changes, who is around and what hurt you. Then decide and submit the next job.

Killing the `run` command only stops its output; the job goes on. `node game.mjs cancel` ends it. A new job replaces the running one.

## The task contract

```js
import { goto } from "mineflayer-world-memory/game/experimental/goto.mjs";

export default async function task(bot, ctx) {
  const [x, y, z] = ctx.args.map(Number); // the words after the file name
  ctx.log("on my way");                   // a line in the run output and the result
  await goto(bot, ctx, [x, y, z]);         // toolkit functions stop by themselves
  if (ctx.signal.aborted) return;          // the exit rule, after your own awaits
  return bot.entity.position.floored();    // the result
}
```

- `ctx.args`, `ctx.log`, `ctx.signal` are all a task needs. `tasks/example.mjs` is a complete one.
- **The one exit rule: after an await, if `ctx.signal.aborted`, return.** The signal aborts on cancel, a new job, a preempt and death; main then stops Pathfinder, fighting, digging, eating and open windows. A task that only calls toolkit functions (`goto`, `craftChecked`) needs no exit code at all.
- The return value is the result; a thrown error is the failure, with its message.
- A task that keeps going after the abort keeps the character: nothing else starts, and `wait` tells you main needs a restart.

## What ends a job without you asking

- **Death.** The job ends; idle starts after respawn. The report has where you died and where you respawned.
- **A reflex preempts it.** A hostile mob hurting you below 12 health starts the `defend` reflex; your head stuck in a block starts `escape`. The job ends with the reflex's result.

Either way, read the report, decide, and submit again. Nothing restarts by itself.

## Between jobs

Idle keeps the character alive: it fights back when hit, gets its head out of blocks, stays at the water surface and eats when hungry. It does not travel or gather.

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

- Pathfinding walks only. After digging down, a job that walks back out fails with no path: dig stairs or pillar up in the task, or allow digging in that task's movements.
- Nothing preempts a job for drowning or a breaking tool: check air and the held tool in tasks that mine, especially near water.
- If `wait` or `status` says main is not running, it crashed: start it again and look at its log.
- After a death or a failed job, append one line to `notes/log.md`: what you were trying and what you will change.

## main.mjs is yours

Which reflexes, idle, reports and plugins it uses is plain code. After editing it, `node game.mjs stop` and start it again. Modules a task imports are cached until main restarts; edits to the task file itself apply on the next run.

<!-- END player guide -->

## Advanced: safepoints and attempts

Optional. By default a preempt or a failed check ends the job and you decide what next. A task can instead offer safepoints where a reflex may preempt it and the task then runs again:

- `await ctx.safepoint({ eat: "restart", defend: "end" })` checks those reflexes at that point. If one is needed, the task leaves and the reflex runs. `restart`: afterwards a new attempt runs the task **from the top** with `ctx.attempt` one higher, and the `run` command keeps following the job. `end`: the job ends and idle takes over.
- `goto(bot, ctx, xyz, { checks: { eat: "restart" } })` offers that safepoint every half second.
- Write a restartable task so a fresh attempt continues from where the character is: read the inventory and position first, skip what is already done.
- Other `ctx` members: `ctx.cleanup(fn)` runs `fn` when the task leaves (for listeners and timers you add); `ctx.wake(reason)` makes `wait` return without ending the job; `ctx.preempt(name, { then, reason })` hands the character to a reflex yourself.

## Library and experimental code

- Plugins main loads (`game/lib/plugins.mjs`): `mineflayer-pathfinder`, `mineflayer-pvp` (`bot.pvp`), `mineflayer-auto-eat` (`bot.autoEat`, automatic eating off), `mineflayer-armor-manager`, `mineflayer-tool` (`bot.tool`), `mineflayer-collectblock` (`bot.collectBlock`). Use them in tasks instead of writing your own fighting, eating or collecting. Pathfinder walks without digging by default; a task that needs digging sets its own movements, and they go back to walking-only when it leaves.
- `<toolkit>/game/index.mjs`: what main is built from (host, reports, damage types, chat, plugins, the crafting fix, `oxygenOf(bot)`).
- `<toolkit>/game/experimental/`: control logic that is still on trial: `goto` (travel), `craftChecked` (craft and check the count), the reflexes `defend`, `escape`, `eat`, idle and the danger observer that preempts with them. Use it, copy it, change it; its README says what has been checked on a server.

## More ways to look

- `node game.mjs query <toolkit>/examples/screenshot.mjs [minX minY minZ maxX maxY maxZ] [views] [solid|open|game] [grid]`: a picture of a box, from corners or above; `pick.mjs IMAGE X Y` turns pixels into block coordinates. Use it when shape decides: doorways, walls, stacked floors.
- If you keep needing something none of the standard ways shows, write a query, or add a report function to main (`host.addReport(name, () => text)`).

## Examples

`<toolkit>/examples/` holds modules that each show one way to do something. Run one as it is (read-only ones with `query`), import it from your own task, or copy and change it. Their first comment says how to call them.

| Example | Shows |
| --- | --- |
| [inspect-placement-entities.mjs](../../examples/inspect-placement-entities.mjs) | Whether an entity blocks a placement. |
| [reach-map.mjs](../../examples/reach-map.mjs) | Where you can walk from here and back. |
| [profile.mjs](../../examples/profile.mjs) | The ground along a line: walls, drops, water. |
| [place-graph.mjs](../../examples/place-graph.mjs) | Which of your waypoints connect, and how. |
| [summarize-terrain.mjs](../../examples/summarize-terrain.mjs) | Local terrain and connectivity as numbers. |
| [screenshot.mjs](../../examples/screenshot.mjs), [pick.mjs](../../examples/pick.mjs) | Pictures of a box; pixels to blocks. |
| [watch-surroundings.mjs](../../examples/watch-surroundings.mjs) | Waiting until a kind of block shows up nearby. |
| [query-block-memory.mjs](../../examples/query-block-memory.mjs) | One block, live first, history only for unloaded chunks. |

## The other skills

- `mineflayer-programs`: writing programs: plugins, cleanup, the watchdog library, connecting without the game process.
- `mineflayer-navigation`: Pathfinder settings, NoPath and stalls, stopping safely before using the hand, waypoints.
- `mineflayer-surroundings`: what the bot knows, blocks, entities, signs, pictures, history, trees.
- `mineflayer-items`: digging, placing, equipping, crafting, chests and furnaces.
- `mineflayer-survival`: eating, fighting, water, beds and respawn points.
