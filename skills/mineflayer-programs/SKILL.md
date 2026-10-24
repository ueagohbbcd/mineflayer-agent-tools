---
name: mineflayer-programs
description: "Writing Mineflayer control programs: module shape, loading plugins once, cancellation and cleanup, sharing one bot between programs, the watchdog, vectors, rules for working (look-act-check, never block the event loop, play fair), this package's helpers, and installing and connecting without mf. Read it before your first program."
---

# Writing control programs

A program is an async function that gets the connected `bot`, does one bounded job and returns. Keep the process that owns `bot` running and call programs from it, so a failed program does not cost the connection.

```js
export default async function inspect(bot) {
  const feet = bot.entity.position.floored();
  return {
    position: bot.entity.position,
    health: bot.health,
    food: bot.food,
    inventory: bot.inventory.items().map((item) => [item.name, item.count]),
    below: bot.blockAt(feet.offset(0, -1, 0))?.name ?? null,
  };
}
```

## Plugins

Load a plugin once per bot and check before loading again:

```js
import pathfinderPkg from "mineflayer-pathfinder";
const { pathfinder, Movements, goals } = pathfinderPkg;

if (!bot.pathfinder) bot.loadPlugin(pathfinder);
bot.pathfinder.setMovements(new Movements(bot));
```

Plugins stay loaded for the life of the bot.

## Cancellation and cleanup

Give long programs an `AbortSignal` (or a deadline) and undo what they started:

```js
import pathfinderPkg from "mineflayer-pathfinder";
const { goals } = pathfinderPkg;

export default async function walkTo(bot, { signal, args }) {
  const [x, y, z] = args.map(Number);
  const stop = () => bot.pathfinder.setGoal(null);
  signal.addEventListener("abort", stop, { once: true });
  try {
    await bot.pathfinder.goto(new goals.GoalNear(x, y, z, 1));
  } finally {
    signal.removeEventListener("abort", stop);
    bot.pathfinder.setGoal(null);
    bot.clearControlStates();
  }
}
```

Remove every listener and timer a program adds (`bot.off`, `clearInterval`) before it returns; leftovers keep firing into the next program.

Under `mf`, the second argument carries the `signal`, which aborts on `mf cancel`, when another program replaces this one, or when the character dies. A program that does not stop within a few seconds gets the character's process restarted, so stop promptly. `mf` also removes listeners on `bot` and timers when the program ends, and stops Pathfinder and PvP; listeners on other objects are still yours.

## Sharing one bot

- Programs on the same bot share movement keys, the Pathfinder goal, the main hand, the open window and the event loop.
- Let one controller own movement and the hand. A listener that only reads (watch for a mob, a block, a chat line) can run beside it and tell the controller, but should not press keys itself.
- A synchronous loop blocks everything, including the bot's own physics. Yield with `await` inside loops, for example `await bot.waitForTicks(1)`.

## Watchdog

Under `mf` every controlling program already has one (its findings are `[watchdog]` lines in the program's output; see `mf-basics`). Elsewhere, or to end a program on a finding (with `export const watchdog = false` under `mf`), wrap a controller with the watchdog to hear about a stuck bot, repeated failures or a blocked event loop:

```js
import { watchdog } from "mineflayer-world-memory/watchdog.mjs";

const dog = watchdog(bot, {
  report: (event) => console.log(event.type, event.message),
});
try {
  // ... the program; on a caught error: dog.failure(error)
} finally {
  dog.close();
}
```

Use `dog.pause()` and `dog.resume()` around intentional stillness (waiting at a door, fishing). See [docs/watchdog.md](../../docs/watchdog.md) for options.

## Vectors

`vec3` methods follow the library: `normalize()` changes the vector in place, `unit()` returns a normalized copy. `offset()`, `plus()` and `floored()` return new vectors.

## How to work

- **Look, act, check.** Read the state you need (position, health, inventory, the blocks around you), do one bounded thing, then read again. The game keeps running between programs: mobs attack, water drowns, items despawn. Leave the character somewhere safe when a program ends.
- **One controller at a time.** Every program on the same bot shares its movement keys, Pathfinder goal, main hand and open window. Let only one program move or use the hand; read-only programs can run beside it.
- **Never block the event loop.** Mineflayer handles packets on the same thread as your code. A synchronous loop freezes the bot (physics, keep-alives, events). `await` between steps.
- **Make programs stoppable.** Clear goals and controls in `finally` (`bot.pathfinder.setGoal(null)`, `bot.clearControlStates()`), and stop on an abort signal or a timeout.
- **Play fair.** Use what Mineflayer and its plugins do. Do not write packets yourself (`bot._client`), change physics, fly, or run commands you are not meant to use. When stuck, solve it in the game: dig, jump, place a block, take another route.

## This package

| Need                                    | Use                                                                                                                                                                                                                                                                                             |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Read one block, live first              | `readWorldBlock(bot, { x, y, z }, memory)` from `mineflayer-world-memory/reader.mjs`. Live blocks win; optional history is read only for unloaded chunks; `source: "unknown"` is not air. Pass `null` as `memory` when you keep no history.                                                     |
| Remember chunks after they unload       | `createWorldMemory(bot, { analysis: "lazy", worldId })` (optional; see `docs/memory-api.md`). History may be stale: check `observedAt`.                                                                                                                                                         |
| A picture of the terrain or a structure | `mineflayer-world-memory/live.mjs`: `observationViewBounds`, `surfaceSnapshotFromBot` + `renderTexturedSurface`, `snapshotFromBot` + `renderOblique`, `saveRender` (see `docs/live-visual.md`). Blank means not received, not air.                                                              |
| The logs of one tree before chopping    | `queryTreeCandidate({ blockAt, seed })` from `mineflayer-world-memory/queries.mjs`.                                                                                                                                                                                                             |
| Notice a stuck or looping program       | Under `mf` every controlling program has one: its findings are `[watchdog]` lines in the program's output (`watchdog.failure(error)` counts an error you caught). Elsewhere: `watchdog(bot, { report })` from `mineflayer-world-memory/watchdog.mjs`; you decide where `report` sends findings. |
| One full sample of your state           | `mf snapshot`                                                                                                                                                                                                                                                                                   |

## Setting up `mf`, or connecting without it

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

`mf start` does this connection for you. Connect yourself only when you cannot use `mf`; then keep one connection per character alive in a long-running process that runs your programs one after another, and wait for `spawn` before reading the world.
