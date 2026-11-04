// The game process. It holds the bot for as long as it runs; edit it freely
// and restart it to apply changes (reconnecting is fine).
//
//   node main.mjs        start in the background, then use game.mjs:
//                        task <file> / query <file> / cancel / status / stop
//
// Env: MF_HOST (localhost) MF_PORT (25565) MF_USERNAME (Bot) MF_VERSION
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import mineflayer from 'mineflayer'
import pathfinderPkg from 'mineflayer-pathfinder'
import { createGame, serve, takeLock, lowAir, noProgress, repeatDeath, repeatNoPath } from 'mineflayer-world-memory/game/index.mjs'

const { pathfinder, Movements } = pathfinderPkg
const dir = path.dirname(fileURLToPath(import.meta.url))

// ---- init -----------------------------------------------------------------
takeLock(dir) // before connecting: a second main for this project exits here
const bot = mineflayer.createBot({
  host: process.env.MF_HOST ?? 'localhost',
  port: Number(process.env.MF_PORT ?? 25565),
  username: process.env.MF_USERNAME ?? 'Bot',
  version: process.env.MF_VERSION || undefined
})
bot.loadPlugin(pathfinder)
bot.once('spawn', () => bot.pathfinder.setMovements(new Movements(bot)))
bot.on('kicked', reason => console.log('被踢出：', reason))
bot.on('end', reason => {
  console.log('连接已断开：', reason)
  process.exit(1)
})
bot.on('error', error => console.log('连接错误：', error.message))

// ---- rules: checked every tick, in order ------------------------------------
// In steps the first rule returning inputs takes the tick; during plugin or
// native code rules only notify; between tasks rule inputs keep the bot safe.
// A task can turn off a rule's inputs with ctx.rules.disable(name).
const rules = [
  lowAir(), // air low → hold jump until recovered; notifies only when nearly out
  noProgress(), // movement keys held 10 s, position barely changes → notice
  repeatDeath(), // died again near the last death → notice
  repeatNoPath() // pathfinder keeps finding no path → notice
]

// ---- idle: between tasks, when no rule is taking over -------------------------
// Return inputs like a step does. In water, float; otherwise stand still.
function idle (bot) {
  if (bot.entity.isInWater) return { jump: true }
  return null
}

// ---- run ----------------------------------------------------------------------
await new Promise(resolve => bot.once('spawn', resolve))
const game = createGame(bot, { dir, rules, idle })
console.log(`已进入游戏：${bot.username} @ ${bot.entity.position}`)

await serve(game) // lock + local socket; one main per project
