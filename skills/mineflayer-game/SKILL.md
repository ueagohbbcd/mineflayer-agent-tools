---
name: mineflayer-game
description: "Start here to play Minecraft Java through a real Mineflayer bot: one game process (main.mjs) holds the character; you submit tasks to it, read what happened with wait, and look at the world through reports, queries, maps and screenshots. Read it first; the mineflayer-* skills cover the subjects."
---

# Playing Minecraft through one game process

You control a character through [Mineflayer](https://github.com/PrismarineJS/mineflayer), a Node.js bot. One process, `main.mjs`, holds the bot for as long as it runs. You write tasks (JavaScript modules) and hand them to it.

**You cannot see the game.** Nothing shows you the world unless you look: read the `wait` report, run queries, draw maps and screenshots (below). Look before you act, and again when something does not go as planned.

## Setup

- Copy `<toolkit>/game/template/` into a project directory and install the toolkit there (`npm install <toolkit tarball> mineflayer mineflayer-pathfinder vec3`). `<toolkit>` below means `node_modules/mineflayer-world-memory`.
- Set `MF_HOST`, `MF_PORT`, `MF_USERNAME` (and `MF_VERSION=1.21.1` for 1.21.1), then start `node main.mjs` **with your tool's background mode**. A second `node main.mjs` in the same directory just says one is running.
- `main.mjs` is yours: which services, idle behaviour and reports it uses are plain code. After editing it, `node game.mjs stop` and start it again (reconnecting is fine).

## The work loop

1. **Submit work in the background:** `node game.mjs run tasks/x.mjs [args...]`. It prints the task's log lines and ends with the result when the work ends. Killing this command does not stop the work; `node game.mjs cancel` does. Submitting new work replaces the running one.
2. **Read what happened:** `node game.mjs wait`. It returns with a report as soon as something happened: the work ended, you died, someone whispered or named you, a service took over. If something already happened while nobody was waiting, it returns at once. Otherwise it blocks, so run it in the background too, or in the foreground when you have nothing else to do.
3. **Read the report even when the `run` output already told you the result.** The report also has your health, food, time until night, inventory changes, who is around and what hurt you.

## Writing a task

```js
// tasks/go.mjs
import { goto } from "mineflayer-world-memory/game/candidates/goto.mjs";

export default async function task(bot, ctx) {
  const [x, y, z] = ctx.args.map(Number);
  ctx.log(`attempt ${ctx.attempt}`);                         // lines go into the result
  await goto(bot, ctx, [x, y, z], { checks: { eat: "pause" } });
  return bot.entity.position.floored();                     // the result
}
```

`ctx` has `args`, `log`, `signal`, `attempt`, `checkpoint(services)`, `cleanup(fn)`, `wake(reason)` and `takeover(service)`.

**Leaving when asked.** Cancelling, a service taking over, new work and death all ask the task to leave the same way: `ctx.signal` aborts, main stops Pathfinder, keys, digging, eating and open windows, and runs your `ctx.cleanup` functions. After an awaited call throws or returns, do not start more game actions once `ctx.signal.aborted` is true. A task that keeps running anyway keeps the character: nothing else starts, and `wait` tells you it needs a restart of main.

**Checkpoints.** `await ctx.checkpoint({ eat: "pause", defend: "stop" })` checks those services at that point. If one is needed, the task leaves and the service runs. `pause`: afterwards the task starts again **from the top** with `ctx.attempt` one higher, and the `run` command keeps following it; write the task so a fresh start continues from where the character is. `stop`: the work ends and idle takes over. The candidate `goto` checks every half second, so a task that only travels with it gets checkpoints for free.

**Takeovers without a checkpoint.** main can stop the work itself: the template's danger check takes over with `defend` when a hostile mob hurts you below 12 health and with `escape` when your head is stuck in a block. The work then ends with the service's result.

**Between tasks** main's idle loop keeps the character alive: it fights back when hit, gets its head out of blocks, stays at the water surface and eats.

Edits to a task file are picked up on the next run; modules it imports are cached until main restarts.

## Commands

| Command | Does |
| --- | --- |
| `node game.mjs run <file> [args]` | submit work, follow it to the end |
| `node game.mjs wait` | return with the report once something happened |
| `node game.mjs cancel` | end the current work |
| `node game.mjs query <file> [args]` | run a read-only module now, even during work (10 s; `GAME_QUERY_TIMEOUT`) |
| `node game.mjs status` / `stop` | who controls the character, the current work / end main |
| `node report.mjs [name] [minutes]` | what the recorders kept (`explore`, `radar`); reads files only |

Results are also in `.game/results/`, records in `records/*.jsonl`.

## Library and candidates

- `<toolkit>/game/index.mjs`: what main is built from (host, reports, damage types, chat, walking-only Pathfinder movements, the crafting fix, `oxygenOf(bot)`).
- `<toolkit>/game/candidates/`: control logic that is still being tried (services, idle, danger takeover, `goto`, `craftChecked`). Use it, copy it, change it; its README says what has been checked on a server.

## Looking at the world

Standard ways to look, from cheap to rich:

- The `wait` report: your state, who is around, what hurt you, chat.
- `node game.mjs query <toolkit>/game/queries/snapshot.mjs`: one full sample now (you, inventory, nearby entities, what is around you in four directions).
- A query of your own for exact facts: `export default async (bot) => bot.blockAt(bot.entity.position.offset(0, -1, 0))?.name`. Check the target cell and what stands in it right before you act, not from what you saw a while ago.
- `node game.mjs query <toolkit>/examples/reach-map.mjs`: where you can walk from here and back, as a text map.
- `node game.mjs query <toolkit>/examples/screenshot.mjs [minX minY minZ maxX maxY maxZ] [views] [solid|open|game] [grid]`: a picture of a box, from corners or above; `pick.mjs IMAGE X Y` turns pixels into block coordinates. Use it when shape decides: doorways, walls, stacked floors.
- `notes/`: write down places, coordinates, how they connect and what it takes to get through; reread before long trips.

When to look: before a task that depends on the surroundings, after a task fails or ends somewhere unexpected, and whenever `wait` returns. These are only the standard ways: if you keep needing something none of them shows, write a query, or add a report function to main (`host.addReport(name, () => text)`).

## Example tasks and queries

`<toolkit>/examples/` holds modules that each show one way to do something. Run one as it is (`node game.mjs run <toolkit>/examples/navigate.mjs X Y Z`; read-only ones with `query`), import it from your own task, or copy and change it. Their first comment says how to call them.

| Example | Shows |
| --- | --- |
| [navigate.mjs](../../examples/navigate.mjs) | A Pathfinder trip that ends when it arrives, fails or stalls (checks it really arrived). |
| [navigate-with-defense.mjs](../../examples/navigate-with-defense.mjs) | A trip with a small close-range defense. |
| [navigate-with-autoeat.mjs](../../examples/navigate-with-autoeat.mjs) | A trip that eats on the way and resumes. |
| [fight-target.mjs](../../examples/fight-target.mjs) | Attacking a chosen entity with PvP. |
| [build-with-autoeat.mjs](../../examples/build-with-autoeat.mjs) | Placing a planned list of blocks, eating between steps. |
| [inspect-placement-entities.mjs](../../examples/inspect-placement-entities.mjs) | Whether an entity blocks a placement (query). |
| [reach-map.mjs](../../examples/reach-map.mjs) | Where you can walk from here and back (query). |
| [profile.mjs](../../examples/profile.mjs) | The ground along a line: walls, drops, water (query). |
| [place-graph.mjs](../../examples/place-graph.mjs) | Which of your waypoints connect, and how (query). |
| [summarize-terrain.mjs](../../examples/summarize-terrain.mjs) | Local terrain and connectivity as numbers (query). |
| [screenshot.mjs](../../examples/screenshot.mjs), [pick.mjs](../../examples/pick.mjs) | Pictures of a box; pixels to blocks (queries). |
| [watch-surroundings.mjs](../../examples/watch-surroundings.mjs) | Waiting until a kind of block shows up nearby. |
| [query-block-memory.mjs](../../examples/query-block-memory.mjs) | One block, live first, history only for unloaded chunks (query). |

## The other skills

- `mineflayer-programs`: writing tasks: plugins, cancellation and cleanup, the watchdog library, connecting without the game process.
- `mineflayer-navigation`: Pathfinder settings, NoPath and stalls, stopping safely before using the hand, waypoints.
- `mineflayer-surroundings`: what the bot knows, blocks, entities, signs, pictures, history, trees.
- `mineflayer-items`: digging, placing, equipping, crafting, chests and furnaces.
- `mineflayer-survival`: eating, fighting, water, beds and respawn points.
