// SPDX-License-Identifier: MIT
// Start the observers for a game. Each writes records/<source>.jsonl through
// game.record; entries it marks urgent also go out with notifyModel.
import { startChatLog } from './chat.mjs'
import { startDanger } from './danger.mjs'
import { startExplore } from './explore.mjs'
import { startRadar } from './radar.mjs'
import { entryLine } from './view.mjs'

/** A `log` for an observer: post(data, { type, key, urgent }). */
export function recordLog (game, source) {
  return {
    post (data, { type, key, urgent = false } = {}) {
      const entry = { ...(type ? { type } : {}), ...(key ? { key } : {}), ...(urgent ? { urgent: true } : {}), data }
      game.record(source, entry)
      if (urgent) game.notify(`[${source}] ${entryLine({ at: new Date().toISOString(), ...entry }).slice(11)}`, { source, type })
      return Promise.resolve()
    }
  }
}

const starters = {
  chat: (bot, log) => startChatLog({ bot, log }),
  danger: (bot, log) => startDanger({ bot, log }),
  explore: (bot, log) => startExplore({ bot, log }),
  radar: (bot, log) => startRadar({ bot, log })
}

/** startObservers(game, ['chat', 'danger', 'explore', 'radar']) → { close() } */
export function startObservers (game, names = Object.keys(starters)) {
  const running = []
  for (const name of names) {
    if (!starters[name]) throw new Error(`unknown observer ${name}; known: ${Object.keys(starters).join(', ')}`)
    running.push(starters[name](game.bot, recordLog(game, name)))
  }
  return { close: () => running.forEach(o => o.close?.()) }
}
