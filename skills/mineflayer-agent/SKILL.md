---
name: mineflayer-agent
description: Play Minecraft Java through a real Mineflayer bot. Installing and joining a server, writing control programs, moving with Pathfinder, looking at the world, items and containers, staying alive, and this package's helpers (live-first block reads, pictures, tree query, watchdog).
---

# Playing Minecraft with Mineflayer

You control a character through [Mineflayer](https://github.com/PrismarineJS/mineflayer), a Node.js bot that speaks the Minecraft Java protocol. You play by writing short JavaScript programs against the `bot` object and running them, then reading what they print.

## Install and join

Node 22 or newer. In a working directory:

```sh
npm install mineflayer mineflayer-pathfinder vec3
npm install "mineflayer-world-memory@https://codeload.github.com/ueagohbbcd/mineflayer-agent-tools/tar.gz/<commit>"
```

Pin `<commit>` to a commit of this repository; the package name stays `mineflayer-world-memory`. Optional plugins: `mineflayer-pvp`, `mineflayer-collectblock`, `mineflayer-auto-eat`.

```js
import mineflayer from "mineflayer";

const bot = mineflayer.createBot({
  host: "localhost",
  port: 25565,
  username: "Steve", // offline-mode servers; use auth: "microsoft" for online ones
  version: "1.21.1", // omit to auto-detect
});
bot.once("spawn", () => console.log("spawned at", bot.entity.position));
bot.on("kicked", (reason) => console.log("kicked", reason));
bot.on("error", (error) => console.log("error", error.message));
```

Keep one connection per character and keep it alive: a long-running process that owns `bot` and runs your programs one after another works better than reconnecting for every step. Wait for `spawn` before reading the world.

## Run programs with `mf` (recommended)

This package ships that long-running process. From your working directory:

```sh
export MF_USERNAME=Steve MF_HOST=localhost
npx mf start                  # connects the character and keeps it alive
npx mf run --inbox 30 look.mjs   # wait for it; if it ends within 30 s, the latest reports follow
npx mf run walk.mjs 100 -40      # long program: start it with your tool's background shell
npx mf inbox                     # what happened in the game since you last read it, at once
npx mf cancel <taskId>        # stop a program (stopping the shell command does not)
```

A module is `export default async function (bot, { signal, args, log }) { ... }`: the real bot, an abort signal, its arguments. The function ending is the program ending.

- **Keep working while the character acts.** Wait in the foreground only for a program that is short (a look, one action) and whose result you need before doing anything else; run anything that walks, fights, gathers or might take longer in the background of your own tool, so you can check `mf inbox` and correct it while it runs; your harness tells you when they end. `mf run` only prints the program's output and result; read `mf inbox` whenever you want to know what is going on in the game. It can go beside a background run in the same batch of calls. When you wait for a program, estimate how long it needs and pass `--inbox S` with S no longer than your tool's foreground wait (if you do not know that wait, use 20).
- **One controlling program per character.** A new `mf run` replaces the running one. Modules with `export const control = false` only read and run beside it. Do not put two controlling runs for the same character in one batch of parallel calls.
- **Changes stop programs.** A death, a dimension change or a crashed process interrupts the character's program, and `mf run` comes back `not_started` until you have read the change in `mf inbox`.
- **When a program ends, the character stops walking and fighting**, so wait for a walk inside the program. Between your programs it defends itself, eats and floats; put your own `idle.mjs` in the working directory to change that, or `mf idle off`.

Details: [runtime/README.md](../../runtime/README.md).

## How to work

- **Look, act, check.** Read the state you need (position, health, inventory, the blocks around you), do one bounded thing, then read again. The game keeps running between programs: mobs attack, water drowns, items despawn. Leave the character somewhere safe when a program ends.
- **One controller at a time.** Every program on the same bot shares its movement keys, Pathfinder goal, main hand and open window. Let only one program move or use the hand; read-only programs can run beside it.
- **Never block the event loop.** Mineflayer handles packets on the same thread as your code. A synchronous loop freezes the bot (physics, keep-alives, events). `await` between steps.
- **Make programs stoppable.** Clear goals and controls in `finally` (`bot.pathfinder.setGoal(null)`, `bot.clearControlStates()`), and stop on an abort signal or a timeout.
- **Play fair.** Use what Mineflayer and its plugins do. Do not write packets yourself (`bot._client`), change physics, fly, or run commands you are not meant to use. When stuck, solve it in the game: dig, jump, place a block, take another route.

## This package

| Need | Use |
| ---- | --- |
| Read one block, live first | `readWorldBlock(bot, { x, y, z }, memory)` from `mineflayer-world-memory/reader.mjs`. Live blocks win; optional history is read only for unloaded chunks; `source: "unknown"` is not air. Pass `null` as `memory` when you keep no history. |
| Remember chunks after they unload | `createWorldMemory(bot, { analysis: "lazy", worldId })` (optional; see `docs/memory-api.md`). History may be stale: check `observedAt`. |
| A picture of the terrain or a structure | `mineflayer-world-memory/live.mjs`: `observationViewBounds`, `surfaceSnapshotFromBot` + `renderTexturedSurface`, `snapshotFromBot` + `renderOblique`, `saveRender` (see `docs/live-visual.md`). Blank means not received, not air. |
| The logs of one tree before chopping | `queryTreeCandidate({ blockAt, seed })` from `mineflayer-world-memory/queries.mjs`. |
| Notice a stuck or looping program | Under `mf`: ``(await import(`${process.env.MF_TOOLKIT_ROOT}/runtime/observation/watchdog.mjs`)).watchdog(bot)``, which reports into your results. Elsewhere: `watchdog(bot, { report })` from `mineflayer-world-memory/watchdog.mjs`; you decide where `report` sends findings. |
| One full sample of your state | `mf snapshot` |

## Guides

Read the one you need:

- [references/programs.md](references/programs.md): program shape, cancellation, plugins, sharing one bot.
- [references/navigation.md](references/navigation.md): Pathfinder settings, NoPath and stalls, stopping safely, waypoints.
- [references/surroundings.md](references/surroundings.md): state, blocks, entities, signs, pictures, history.
- [references/items.md](references/items.md): digging, placing, equipping, crafting, chests and furnaces.
- [references/survival.md](references/survival.md): eating, fighting, water, beds and respawn points.
