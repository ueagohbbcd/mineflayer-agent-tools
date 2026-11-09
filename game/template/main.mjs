// The game process. It holds the bot for as long as it runs; edit it freely
// and restart it to apply changes (reconnecting is fine).
//
//   node main.mjs        start in the background, then use game.mjs:
//                        run <file> / wait / cancel / query <file> / status / stop
//
// Env: MF_HOST (localhost) MF_PORT (25565) MF_USERNAME (Bot) MF_VERSION
// (empty = ask the server; give it for 1.21.1 to get the recipe-packet fix)
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import mineflayer from 'mineflayer'
import {
  createHost, serve, takeLock, compatibleMinecraftOptions, fixCrafting, loadPlugins, stopGameActions,
  watchDamage, watchChat, statusReport, radarReport, recordLog, startExplore, startRadar
} from 'mineflayer-world-memory/game/index.mjs'
// Candidates: control logic still being tried out (game/candidates/README.md).
import { defend, escape, eat } from 'mineflayer-world-memory/game/candidates/services.mjs'
import { idle } from 'mineflayer-world-memory/game/candidates/idle.mjs'
import { dangerTakeover } from 'mineflayer-world-memory/game/candidates/danger-takeover.mjs'

const dir = path.dirname(fileURLToPath(import.meta.url))

// ---- connect ------------------------------------------------------------------
takeLock(dir) // before connecting: a second main for this project exits here
const bot = mineflayer.createBot(compatibleMinecraftOptions({
  host: process.env.MF_HOST ?? 'localhost',
  port: Number(process.env.MF_PORT ?? 25565),
  username: process.env.MF_USERNAME ?? 'Bot',
  version: process.env.MF_VERSION || undefined
}))
const spawned = new Promise(resolve => bot.once('spawn', resolve))
const damage = watchDamage(bot) // right after createBot: damage type names arrive before spawn
fixCrafting(bot) // bot.craft clears the grid after itself (1.21.1 leftovers)
// Pathfinder (walking only: no digging, no towering), pvp, auto-eat,
// armor-manager, tool, collectblock; see game/lib/plugins.mjs.
await loadPlugins(bot)
bot.on('kicked', reason => console.log('被踢出：', reason))
bot.on('end', reason => {
  console.log('连接已断开：', reason)
  process.exit(1)
})
bot.on('error', error => console.log('连接错误：', error.message))
await spawned
console.log(`已进入游戏：${bot.username} @ ${bot.entity.position}`)

// ---- host: tasks, services, idle ------------------------------------------------
// Services can be named in a task's ctx.checkpoint({ eat: 'pause' }) or taken
// over with host.takeover(name). idle runs when there is no work. Every exit
// stops the plugins and puts the walking-only movements back.
const host = createHost(bot, {
  dir,
  services: { defend, escape, eat },
  idle,
  cleanup: stopGameActions
})

// Report functions: their output is joined into what `game.mjs wait` prints.
host.addReport('状态', statusReport(bot))
host.addReport('周围', radarReport(bot))
host.addReport('受伤', () => damage.report())
const chat = watchChat(bot, { wake: host.wake })
host.addReport('聊天', () => chat.report())

// Being hurt badly by a mob, or suffocating: stop the work and defend.
dangerTakeover(bot, host, damage)

// Records for `node report.mjs` (what was seen, who was around).
startExplore({ bot, log: recordLog(dir, 'explore') })
startRadar({ bot, log: recordLog(dir, 'radar') })

await serve(host) // local socket; one main per project
