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
  createHost, openEntry, serve, compatibleMinecraftOptions, fixCrafting, loadPlugins, stopGameActions,
  watchDamage, watchChat, statusReport, upkeepReport, radarReport, recordLog, startJournal, startExplore, startRadar
} from 'mineflayer-world-memory/game/index.mjs'
// Experimental: control logic still being tried out (game/experimental/README.md).
import { fightOrFlee, digHeadFree, eatWhenHungry, surfaceForAir } from 'mineflayer-world-memory/game/experimental/reflexes.mjs'
import { stayAlive } from 'mineflayer-world-memory/game/experimental/stay-alive.mjs'
import { preemptWhenHurt } from 'mineflayer-world-memory/game/experimental/preempt-when-hurt.mjs'
import { preemptWhenDrowning } from 'mineflayer-world-memory/game/experimental/preempt-when-drowning.mjs'

const dir = path.dirname(fileURLToPath(import.meta.url))

// ---- connect ------------------------------------------------------------------
// The local socket, bound before connecting: one main per project, so a
// second main for this project exits here.
const entry = await openEntry(dir)
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
const plugins = await loadPlugins(bot)
// The game's timeline in records/journal.jsonl: `node report.mjs review`.
const journal = startJournal({ bot, dir, damage, plugins })
bot.on('kicked', reason => console.log('kicked:', reason))
bot.on('end', reason => {
  console.log('disconnected:', reason)
  process.exit(1)
})
bot.on('error', error => console.log('connection error:', error.message))
await spawned
console.log(`joined the game: ${bot.username} at ${bot.entity.position}`)

// ---- host: tasks, reflexes, idle ------------------------------------------------
// Reflexes can be named in a task's ctx.safepoint({ eatWhenHungry: 'restart' })
// or preempt with host.preempt(name). The idle loop (stayAlive) runs when there
// is no job. Every exit stops the plugins and puts the walking-only movements back.
const host = createHost(bot, {
  dir,
  reflexes: { fightOrFlee, digHeadFree, eatWhenHungry, surfaceForAir },
  idle: stayAlive,
  cleanup: stopGameActions,
  onEvent: journal.event
})

// The previous main crashed or exited with an error: the first `wait` says so.
if (journal.previousEnd) host.wake(journal.previousEnd)

// Report functions: their output is joined into what `game.mjs wait` prints.
host.addReport('status', statusReport(bot))
host.addReport('upkeep', upkeepReport(bot)) // tools breaking, food, what idle and reflexes did
host.addReport('nearby', radarReport(bot))
host.addReport('damage', () => damage.report())
const chat = watchChat(bot, { wake: host.wake })
host.addReport('chat', () => chat.report())

// Observers: being hurt badly by a mob, or suffocating, preempts the job with
// fightOrFlee or digHeadFree; running out of air under water, with surfaceForAir.
preemptWhenHurt(bot, host, damage)
preemptWhenDrowning(bot, host, damage)

// Records for `node report.mjs` (what was seen, who was around).
startExplore({ bot, log: recordLog(dir, 'explore') })
startRadar({ bot, log: recordLog(dir, 'radar') })

await serve(host, entry) // requests reach the host from now on
