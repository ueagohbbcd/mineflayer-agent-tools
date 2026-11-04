---
name: mineflayer-game
description: "Start here to play Minecraft Java through a real Mineflayer bot: one game process (main.mjs) holds the character; you submit tasks and read-only queries to it, keep a wait running so notices reach you, and look at the world through reports, queries, maps and screenshots. Read it first; the mineflayer-* skills cover the subjects."
---

# Playing Minecraft through one game process

You control a character through [Mineflayer](https://github.com/PrismarineJS/mineflayer), a Node.js bot. One process, `main.mjs`, holds the bot for as long as it runs. You write tasks (JavaScript modules) and hand them to it.

**You cannot see the game.** Nothing shows you the world unless you look: read the reports, run queries, draw maps and screenshots (below). Look before you act, and again when something does not go as planned.

## Setup

- Copy `<toolkit>/game/template/` into a project directory and install the toolkit there (`npm install <toolkit tarball> mineflayer mineflayer-pathfinder mineflayer-pvp vec3`). `<toolkit>` below means `node_modules/mineflayer-world-memory`.
- Set `MF_HOST`, `MF_PORT`, `MF_USERNAME` (and `MF_VERSION=1.21.1` for 1.21.1), then start `node main.mjs` **with your tool's background mode**. It connects, starts the observers and keeps running. A second `node main.mjs` in the same directory just says one is running.
- `main.mjs` is yours: its rules, idle behaviour and observers are plain code. After editing it, `node game.mjs stop` and start it again (reconnecting is fine).

## Three things that work differently

**1. Keep a `wait` running before you end your turn.** `node wait.mjs` blocks until there is a notice (a task finished after you stopped waiting for it, a rule saw trouble, danger), prints it and exits; its exit is what brings you back. Start it in the background every time it has exited, before you end your turn. Without one you are not woken; notices are kept for the next `wait`. A foreground command still running in the same batch delays the notice until it returns.

**2. Tasks run inside main.** A task is a module; `node game.mjs task tasks/go.mjs [args...]` loads its current version into main, runs it, and prints the result when it ends:

```js
// tasks/go.mjs
import pathfinderPkg from "mineflayer-pathfinder";
const { goals } = pathfinderPkg;

export default async function task(bot, { args, signal, log }) {
  const [x, y, z] = args.map(Number);
  await bot.pathfinder.goto(new goals.GoalNear(x, y, z, 1));
  log("arrived");                       // lines go into the result
  return bot.entity.position.floored(); // the result
}
```

One task at a time: another `task` answers busy; `node game.mjs cancel` asks it to stop (the bot is handed back only when it has really stopped). If the `task` command is cut off (timeout, killed), the task goes on and its result comes as a notice. Edits to the task file are picked up at once; modules it imports are cached until main restarts. Use `ctx.on(emitter, event, fn)` for listeners that should go away with the task.

**3. `steps` for simple movement (optional).** Inside a task, `steps(fn)` calls `fn` every game tick (20 per second). `fn` returns the control keys to hold this tick (`forward back left right jump sprint sneak`, plus `look: { yaw, pitch }`), or `{ done: true, result }`; keys you leave out are released. It must return at once; keep state in variables outside it. main's rules are checked first each tick and may take a tick over (for example: air low → swim up); your `fn` continues from wherever the character then is, and the result lists every takeover.

```js
export default async function task(bot, { steps }) {
  return await steps(() => {
    if (bot.entity.position.x >= 40) return { done: true, result: "east enough" };
    return { forward: true, look: { yaw: -Math.PI / 2, pitch: 0 } }; // walk east
  });
}
```

Plugins (Pathfinder, PvP) run as usual outside `steps`; then rules only notify. Between tasks the rules and main's `idle` keep the character safe. `ctx.rules.disable(name)` turns off one rule's takeover for this task (its notice stays), for example to dive on purpose.

## Commands

| Command | Does |
| --- | --- |
| `node game.mjs task <file> [args]` | run a task, print its result |
| `node game.mjs query <file> [args]` | run a read-only module now, even during a task (10 s; `GAME_QUERY_TIMEOUT`) |
| `node game.mjs cancel` / `status` / `stop` | ask the task to stop / what runs and which keys are held / end main |
| `node wait.mjs` | block until a notice, print it, exit |
| `node report.mjs [name] [minutes]` | what the observers recorded; reads files only, works with main stopped |

Results are also in `.game/results/`, notices in `.game/notices.jsonl`, records in `records/*.jsonl`: plain files you can grep.

## Looking at the world

Standard ways to look, from cheap to rich:

- `node report.mjs`: what was recorded and how much. `danger` (damage, threats, hunger, air), `radar` (who and what came and went), `explore` (blocks and signs passed), `chat`, `rules` (every takeover and notice), `tasks`.
- `node game.mjs query <toolkit>/game/queries/snapshot.mjs`: one full sample now (you, inventory, nearby entities, what is around you in four directions).
- A query of your own for exact facts: `export default async (bot) => bot.blockAt(bot.entity.position.offset(0, -1, 0))?.name`. Check the target cell and what stands in it right before you act, not from what you saw a while ago.
- `node game.mjs query <toolkit>/examples/reach-map.mjs`: where you can walk from here and back, as a text map.
- `node game.mjs query <toolkit>/examples/screenshot.mjs [minX minY minZ maxX maxY maxZ] [views] [solid|open|game] [grid]`: a picture of a box, from corners or above; `pick.mjs IMAGE X Y` turns pixels into block coordinates. Use it when shape decides: doorways, walls, stacked floors.
- `notes/`: write down places, coordinates, how they connect and what it takes to get through; reread before long trips.

When to look: before a task that depends on the surroundings, after a task fails or ends somewhere unexpected, and whenever a notice arrives. These are only the standard ways: you are the one who can tell what else matters here. If you notice you keep needing something none of them shows, write a query or an observer for it.

## Example tasks and queries

`<toolkit>/examples/` holds modules that each show one way to do something. Run one as it is (`node game.mjs task <toolkit>/examples/navigate.mjs X Y Z`; read-only ones with `query`), import it from your own task, or copy and change it. Their first comment says how to call them.

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
