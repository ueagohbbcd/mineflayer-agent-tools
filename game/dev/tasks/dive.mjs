import { airOf } from 'mineflayer-world-memory/game/index.mjs'
// Intentional dive: turn off low-air's inputs, walk west along the bottom
// until air is nearly gone. The low-air notice should still arrive.
const WEST = Math.PI / 2

export default async function task (bot, { steps, rules }) {
  rules.disable('low-air')
  return await steps(() => {
    if (airOf(bot) <= 2) return { done: true, result: { air: airOf(bot), x: Math.round(bot.entity.position.x) } }
    return { forward: true, look: { yaw: WEST, pitch: 0 } }
  })
}
