// SPDX-License-Identifier: MIT
// Everything about the ecosystem plugins in one place: loading them, the
// walking-only Pathfinder default, the stop-everything cleanup that the exit
// flow runs, and one Mineflayer quirk (air after respawn). Observations behind
// each quirk: game/experimental/README.md.
//
//   await loadPlugins(bot)                    right after createBot
//   createHost(bot, { cleanup: stopGameActions, ... })
import pathfinderPkg from 'mineflayer-pathfinder'
import { airIndex } from '../observation/snapshot.mjs'
const { Movements } = pathfinderPkg

// Optional plugins: a missing one is skipped and its bot.<name> stays undefined.
const OPTIONAL = [
  // bot.pvp.attack(entity), bot.pvp.forceStop(): follows and swings until the target dies.
  ['mineflayer-pvp', mod => mod.plugin],
  // bot.autoEat.eat(): picks the best food, eats, puts the old item back. Its
  // automatic eating stays off; the eat reflex decides when.
  ['mineflayer-auto-eat', mod => mod.loader],
  // Puts on better armour as it is picked up (seen: an iron chestplate went on by itself).
  ['mineflayer-armor-manager', mod => mod.default],
  // bot.tool.equipForBlock(block): the right tool before digging.
  ['mineflayer-tool', mod => mod.plugin],
  // bot.collectBlock.collect(blocks): walks to, digs and picks up blocks. It
  // only breaks blocks the current movements may dig, so with the walking-only
  // default it collects nothing; a task that collects sets digging movements.
  ['mineflayer-collectblock', mod => mod.plugin]
]

/** Loads Pathfinder and the optional plugins; puts the walking-only default back on every spawn. Returns the names loaded. */
export async function loadPlugins (bot) {
  bot.loadPlugin(pathfinderPkg.pathfinder)
  const loaded = ['mineflayer-pathfinder']
  for (const [name, pick] of OPTIONAL) {
    let mod
    try { mod = await import(name) } catch { continue }
    bot.loadPlugin(pick(mod))
    loaded.push(name)
  }
  bot.on('spawn', () => defaultMovements(bot))
  if (bot.entity) defaultMovements(bot) // spawned while the imports loaded
  // Mineflayer keeps the entity's metadata across a respawn and the server
  // sends no air value while it is full, so after a drowning death oxygenOf
  // read the last value under water (-1, playtest 2026-11-10) until the next dive.
  bot.on('respawn', () => { if (bot.entity?.metadata) delete bot.entity.metadata[airIndex(bot)] })
  return loaded
}

/**
 * Pathfinder movements that only walk, jump, swim and climb: no digging, no
 * placing blocks, no pillaring. Pathfinder's own default digs; in the
 * 2026-11-04 playtest that dug into caves, through shelters and through a
 * furnace. A task that wants digging sets its own movements.
 */
export function walkingMovements (bot) {
  const moves = new Movements(bot)
  moves.canDig = false
  moves.allow1by1towers = false
  moves.scafoldingBlocks = []
  return moves
}

/**
 * The walking-only movements, also for pvp and collectblock: each of them
 * switches Pathfinder to its own digging movements on every call unless its
 * `movements` is null (seen on a local server: both switched it on each call;
 * with theirs set to null, Pathfinder still walked only after a fight).
 */
export function defaultMovements (bot) {
  bot.pathfinder?.setMovements(walkingMovements(bot))
  if (bot.pvp) bot.pvp.movements = null
  if (bot.collectBlock) bot.collectBlock.movements = null
}

/**
 * The game cleanup of the exit flow: stops whatever a task, reflex or idle
 * left running on the bot, then puts the default movements back.
 */
export function stopGameActions (bot) {
  try { bot.pathfinder?.setGoal(null) } catch {}
  try { bot.pvp?.forceStop?.() } catch {}
  try { bot.collectBlock?.cancelTask?.().catch(() => {}) } catch {}
  try { bot.autoEat?.cancelEat?.() } catch {}
  try { bot.clearControlStates?.() } catch {}
  try { if (bot.targetDigBlock) bot.stopDigging() } catch {}
  try { bot.deactivateItem?.() } catch {}
  try { if (bot.currentWindow) bot.closeWindow(bot.currentWindow) } catch {}
  try { defaultMovements(bot) } catch {}
}
