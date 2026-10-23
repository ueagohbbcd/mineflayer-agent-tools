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
export default async function walkTo(bot, { signal, x, y, z }) {
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

Wrap a controller with the watchdog to hear about a stuck bot, repeated failures or a blocked event loop:

```js
import { watchdog } from "mineflayer-world-memory/watchdog.mjs";

const dog = watchdog(bot, { report: (event) => console.log(event.type, event.message) });
try {
  // ... the program; on a caught error: dog.failure(error)
} finally {
  dog.close();
}
```

Use `dog.pause()` and `dog.resume()` around intentional stillness (waiting at a door, fishing). See `docs/watchdog.md` for options.

## Vectors

`vec3` methods follow the library: `normalize()` changes the vector in place, `unit()` returns a normalized copy. `offset()`, `plus()` and `floored()` return new vectors.
