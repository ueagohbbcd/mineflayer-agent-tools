---
name: mf-basics
description: "Start here to play Minecraft Java through a real Mineflayer bot with mf: start or find your character, run programs on it, read the game log, background modules (chat, danger, radar, explore, watchdog), the work loop of short programs with milestone lines, and the example programs. Read it first; the mineflayer-* skills cover the subjects."
---

# Playing Minecraft with `mf`

You control a character through [Mineflayer](https://github.com/PrismarineJS/mineflayer), a Node.js bot that speaks the Minecraft Java protocol. `mf` keeps the character connected and runs your programs on it: you write short JavaScript modules against the `bot` object, run them, and read what they print and what the log says.

## Start here

First check whether a character is already running for you: `mf status` (or `npx mf status`). If it lists your character, the environment set it up: skip installing and connecting, never call `createBot` yourself, and use `mf` as below. Otherwise install the package (the `mineflayer-programs` skill, "Setting up `mf`") and start it from your working directory:

```sh
export MF_USERNAME=Steve MF_HOST=localhost
npx mf start                  # connects the character and keeps it alive
npx mf run look.mjs           # short program: wait for it
npx mf run walk.mjs 100 -40   # long program: start it with your tool's background shell
npx mf log                    # what happened in the game since you last read it, summed up
npx mf cancel <taskId>        # stop a program (stopping the shell command does not)
```

A module is `export default async function (bot, { signal, args, log }) { ... }`: the real bot, an abort signal, its arguments. The function ending is the program ending.

- **Short steps that end on a decision.** Each program does one piece of work and ends when it is done, when it found what it looked for, or when it needs you to decide (say why in its result). It prints one line at each milestone (arrived, found, opened, crafted), so its output shows how far it got.
- **Keep working while the character acts.** Wait in the foreground only for a short program whose result you need next; run anything that walks, fights or gathers in your tool's background shell, with a wait no longer than you would go without news (often 30 to 90 seconds). When the wait ends without a new milestone line, read its output and `mf log`, then let it go on or `mf cancel` it.
- **One controlling program per character.** A new `mf run` replaces the running one. Modules with `export const control = false` only read and run beside it. Do not put two controlling runs for the same character in one batch of parallel calls.
- **Write programs that cope rather than stop.** Handle foreseeable trouble in code (another path, eating, fighting back, retrying a step) instead of ending at the first surprise; check few assumptions up front.
- **Urgent news comes back early.** An urgent log entry (critical health with the danger module, chat that names you when enabled, a program's `{ urgent: true }` entry) makes a waiting `mf run` return at once as `running`, with only the reason; read `mf log` for the rest. The program keeps going.
- **Stops stop programs.** A death, a dimension change or a crashed process interrupts the character's program; the next `mf run` starts by printing what stopped it.
- **Every controlling program has a watchdog.** When the character tries to move but does not, or the same failure repeats, a `[watchdog] …` line appears in the program's output and an urgent `program-watchdog` entry makes a waiting `mf run` return early. The program keeps running; `mf log --source program-watchdog` has the finding. `export const watchdog = false` turns it off.
- **When a program ends, the character stops walking and fighting**, so wait for a walk inside the program. While a program runs, keeping the character alive is that program's job; only between programs does it defend itself, eat and float on its own; put your own `idle.mjs` in the working directory to change that, or `mf idle off`.
- **More in the background when you want it.** Only chat is logged by default. `mf run --keep $MF_TOOLKIT_ROOT/runtime/default-scripts/danger.mjs` (damage and threats, urgent), `radar.mjs` (who comes and goes), `explore.mjs` (blocks and signs you pass) or `watchdog.mjs` (trends over minutes) add their own section to `mf log`.

Details: [runtime/README.md](../../runtime/README.md).

Installing the package and connecting without `mf`: the `mineflayer-programs` skill.

## Example programs

`examples/` holds short programs that each show one way to do a task. They are examples, not a fixed toolset: read one to see how it is done, then run it as it is or copy it into your directory and change it. Under `mf`, run one as `mf run "$MF_TOOLKIT_ROOT/examples/navigate.mjs" X Y Z`; its first comment says how to call it.

| Example                                                                         | Shows                                                                            |
| ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| [navigate.mjs](../../examples/navigate.mjs)                                     | A Pathfinder trip that ends when it arrives, fails or stalls.                    |
| [navigate-with-defense.mjs](../../examples/navigate-with-defense.mjs)           | A trip with a small close-range defense, reporting each fight.                   |
| [navigate-with-autoeat.mjs](../../examples/navigate-with-autoeat.mjs)           | A trip that eats on the way and resumes the route.                               |
| [fight-target.mjs](../../examples/fight-target.mjs)                             | Attacking a chosen entity with PvP.                                              |
| [build-with-autoeat.mjs](../../examples/build-with-autoeat.mjs)                 | Placing a planned list of blocks, eating between steps.                          |
| [inspect-placement-entities.mjs](../../examples/inspect-placement-entities.mjs) | Checking that no entity blocks a placement (read-only).                          |
| [reach-map.mjs](../../examples/reach-map.mjs)                                   | Where you can walk from here and back, as a text map (read-only).                |
| [profile.mjs](../../examples/profile.mjs)                                       | The ground along a line: walls, drops, water (read-only).                        |
| [place-graph.mjs](../../examples/place-graph.mjs)                               | Which of your waypoints connect, and how (read-only).                            |
| [summarize-terrain.mjs](../../examples/summarize-terrain.mjs)                   | Local terrain and connectivity as numbers (read-only).                           |
| [watch-surroundings.mjs](../../examples/watch-surroundings.mjs)                 | Waiting until a kind of block shows up nearby, then ending.                      |
| [entity-radar.mjs](../../examples/entity-radar.mjs)                             | Nearby entities as one report kept up to date (read-only).                       |
| [query-block-memory.mjs](../../examples/query-block-memory.mjs)                 | One block, live first, history only for unloaded chunks (read-only).             |
| [native.mjs](../../examples/native.mjs)                                         | Loading Pathfinder and PvP once on the shared bot; the other examples import it. |

The examples import `mineflayer-pathfinder`, `mineflayer-pvp` and `vec3`; install them beside this package.

## The other skills

Peer skills, each on its own subject. Read the one you need when you need it:

- `mineflayer-programs`: program shape, plugins, cancellation, sharing one bot, the watchdog, connecting without `mf`, and this package's helpers.
- `mineflayer-navigation`: Pathfinder settings, NoPath and stalls, stopping safely before using the hand, waypoints.
- `mineflayer-surroundings`: what the bot knows, blocks, entities, signs, pictures, history, trees.
- `mineflayer-items`: digging, placing, equipping, crafting, chests and furnaces.
- `mineflayer-survival`: eating, fighting, water, beds and respawn points.
