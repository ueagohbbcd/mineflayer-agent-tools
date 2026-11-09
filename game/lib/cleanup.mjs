// SPDX-License-Identifier: MIT
// Stops what a task, service or idle may have left running on the bot. The
// exit flow calls it; it only touches state that belongs to the bot itself.
export function stopGameActions (bot) {
  try { bot.pathfinder?.setGoal(null) } catch {}
  try { bot.pvp?.forceStop?.() } catch {}
  try { bot.collectBlock?.cancelTask?.().catch(() => {}) } catch {}
  try { bot.autoEat?.cancelEat?.() } catch {}
  try { bot.clearControlStates?.() } catch {}
  try { if (bot.targetDigBlock) bot.stopDigging() } catch {}
  try { bot.deactivateItem?.() } catch {}
  try { if (bot.currentWindow) bot.closeWindow(bot.currentWindow) } catch {}
}
