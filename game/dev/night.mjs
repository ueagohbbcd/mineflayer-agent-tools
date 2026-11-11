// Night idle for game/dev/SCENARIOS.md: puts the bot on open ground at night
// with natural spawning on, then only watches for `minutes` (status, vitals
// query, RCON death count every second). Run it in the test project
// directory while main is running there.
//
//   node <toolkit>/game/dev/night.mjs [x=300] [z=300] [minutes=5]
//
// Set-up: time 18000 with the daylight cycle off (it stays night), natural
// spawning on, spreadplayers onto the surface near x z, stone sword and
// 8 bread, full health. Appends one JSON line to night-results.jsonl.
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { rcon } from './rcon.mjs'
import { socketPath } from '../lib/server.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const dir = path.resolve(process.env.GAME_DIR ?? '.')
const NAME = process.env.MF_USERNAME ?? 'Scen'
const [x = '300', z = '300', minutes = '5'] = process.argv.slice(2)
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const r1 = n => Math.round(n * 10) / 10

function request (body) {
  return new Promise((resolve, reject) => {
    const conn = net.connect(socketPath(dir))
    let buffer = ''
    let last = null
    conn.setEncoding('utf8')
    conn.on('connect', () => conn.write(JSON.stringify(body) + '\n'))
    conn.on('data', chunk => {
      buffer += chunk
      for (let nl; (nl = buffer.indexOf('\n')) >= 0;) {
        const line = buffer.slice(0, nl)
        buffer = buffer.slice(nl + 1)
        if (line) last = JSON.parse(line)
      }
    })
    conn.on('close', () => resolve(last))
    conn.on('error', reject)
  })
}
const status = () => request({ type: 'status' })
const vitals = async () => (await request({ type: 'query', file: path.join(here, 'queries/vitals.mjs'), args: [], timeoutMs: 3000 }))?.result
const deaths = async () => Number((await rcon([`scoreboard players get ${NAME} fightDeaths`]))[0].match(/has (\d+)/)?.[1] ?? 0)

if ((await status()).job?.status === 'running') await request({ type: 'cancel' })
await rcon(['scoreboard objectives add fightDeaths deathCount', 'gamerule naturalRegeneration true', 'gamerule mobGriefing true',
  `forceload add ${x} ${z}`, `spreadplayers ${x} ${z} 0 5 false ${NAME}`, `forceload remove ${x} ${z}`])
await sleep(3000)
await rcon([`clear ${NAME}`, `effect clear ${NAME}`, `give ${NAME} stone_sword`, `give ${NAME} bread 8`,
  `effect give ${NAME} instant_health 1 5`, 'time set 18000', 'gamerule doDaylightCycle false', 'gamerule doMobSpawning true'])
await sleep(2000)
if ((await status()).pending) await request({ type: 'wait' })
const v0 = await vitals()
const start = v0.position
const d0 = await deaths()
const t0 = Date.now()
let hmin = v0.health
let fmin = v0.food
let maxDist = 0
let died = 0
const ctrls = []
while (Date.now() - t0 < Number(minutes) * 60000) {
  await sleep(1000)
  const s = await status()
  const c = s.controller ? `${s.controller.kind}:${s.controller.name}` : 'none'
  if (ctrls.at(-1) !== c) ctrls.push(c)
  died = (await deaths()) - d0
  if (died) break
  const v = await vitals()
  if (!v) continue
  hmin = Math.min(hmin, v.health)
  fmin = Math.min(fmin, v.food)
  maxDist = Math.max(maxDist, Math.hypot(v.position[0] - start[0], v.position[2] - start[2]))
}
const v1 = await vitals()
const mobs = (await rcon([`execute as ${NAME} at @s if entity @e[type=#minecraft:undead,distance=..24]`, `execute as ${NAME} at @s if entity @e[type=spider,distance=..24]`, `execute as ${NAME} at @s if entity @e[type=creeper,distance=..24]`]))
const report = (await status()).pending ? (await request({ type: 'wait' }))?.text ?? '' : '(nothing woke)'
await rcon(['gamerule doMobSpawning false', 'gamerule mobGriefing false'])
const row = {
  at: new Date().toISOString(), start: start.map(r1), seconds: r1((Date.now() - t0) / 1000), died,
  healthStart: r1(v0.health), healthMin: r1(hmin), healthEnd: r1(v1.health), foodMin: fmin, foodEnd: v1.food,
  maxDistFromStart: r1(maxDist), endDistFromStart: r1(Math.hypot(v1.position[0] - start[0], v1.position[2] - start[2])),
  controllers: ctrls, mobsNearEnd: mobs.map(m => m.match(/count: (\d+)/)?.[1] ?? '0')
}
fs.appendFileSync(path.join(dir, 'night-results.jsonl'), JSON.stringify(row) + '\n')
fs.appendFileSync(path.join(dir, 'night-reports.log'), `\n===== ${row.at}\n${report}\n`)
console.log(JSON.stringify(row))
process.exit(0)
