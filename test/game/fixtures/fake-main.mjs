// A main with a stand-in bot, for the cross-process tests.
import { EventEmitter } from 'node:events'
import { createHost } from '../../../game/lib/host.mjs'
import { serve } from '../../../game/lib/server.mjs'

const bot = new EventEmitter()
bot.health = 20
bot.entity = { position: { x: 1, y: 64, z: 2 } }
bot.quit = () => {}
const host = createHost(bot, { dir: process.env.GAME_DIR, graceMs: 500, log: () => {}, cleanup: () => {} })
host.addReport('status', () => 'hp 20')
await serve(host, { blockedMs: 1000 })
console.log('ready')
