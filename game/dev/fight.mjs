// Staged fights in the arena for game/dev/SCENARIOS.md (scenario 13). Run it
// in the test project directory while main is running there. It sets each run
// up with RCON, then only watches: every 0.5 s it reads status and the vitals
// query through the socket and counts the mobs with RCON. What it prints is
// what it saw; it decides nothing for the bot.
//
//   node <toolkit>/game/dev/fight.mjs <mob> <goto|idle> [runs=3] [sword=iron_sword] [health=20]
//   mob: skeleton | spider | zombie2 | creeper
//
// Arena (SCENARIOS.md): stone floor y=120, x -51..29, z -206..-126, glass
// walls. Each run sets midnight, no daylight cycle and no natural spawning
// (undead do not burn, spiders attack, no other mobs join). The bot starts at
// A, mobs are summoned 12 blocks east of A; in goto mode the bot walks
// A → B → A … (patrol.mjs, FIGHT_LEGS legs, default 6, about 70 blocks each).
// Each run appends one JSON line to fight-results.jsonl and saves the `wait`
// report after the run to fight-reports.log.
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { rcon } from './rcon.mjs'
import { socketPath } from '../lib/server.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const dir = path.resolve(process.env.GAME_DIR ?? '.')
const NAME = process.env.MF_USERNAME ?? 'Scen'
const [mob, mode = 'idle', runsArg = '3', sword = 'iron_sword', healthArg = '20'] = process.argv.slice(2)
const LEGS = Number(process.env.FIGHT_LEGS ?? 6) // patrol legs in goto mode
const A = [-46.5, 121, -165.5]
const B = [24, 121, -166]
const KEEP = '{PersistenceRequired:1b}'
const MOBS = {
  skeleton: { type: 'skeleton', summon: [`summon skeleton -34.5 121 -165.5 ${KEEP}`] },
  spider: { type: 'spider', summon: [`summon spider -34.5 121 -165.5 ${KEEP}`] },
  zombie2: { type: 'zombie', summon: [`summon zombie -34.5 121 -167.5 ${KEEP}`, `summon zombie -34.5 121 -163.5 ${KEEP}`] },
  creeper: { type: 'creeper', summon: [`summon creeper -34.5 121 -165.5 ${KEEP}`] }
}
if (!MOBS[mob] || !['goto', 'idle'].includes(mode)) {
  console.log('用法：node fight.mjs <skeleton|spider|zombie2|creeper> <goto|idle> [runs] [sword] [health]')
  process.exit(1)
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function request (body, onMessage) {
  return new Promise((resolve, reject) => {
    const conn = net.connect(socketPath(dir))
    let buffer = ''
    let last = null
    conn.setEncoding('utf8')
    conn.on('connect', () => conn.write(JSON.stringify(body) + '\n'))
    conn.on('data', chunk => {
      buffer += chunk
      let nl
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl)
        buffer = buffer.slice(nl + 1)
        if (line) { last = JSON.parse(line); onMessage?.(last) }
      }
    })
    conn.on('close', () => resolve(last))
    conn.on('error', reject)
  })
}
const status = () => request({ type: 'status' })
const vitals = async () => (await request({ type: 'query', file: path.join(here, 'queries/vitals.mjs'), args: [], timeoutMs: 3000 }))?.result
// Only the arena: other loaded chunks have their own mobs.
const ARENA = 'x=-51,y=118,z=-206,dx=80,dy=12,dz=80'
const mobCount = async () => Number((await rcon([`execute if entity @e[type=${MOBS[mob].type},${ARENA}]`]))[0].match(/count: (\d+)/)?.[1] ?? 0)
const dist = (p, q) => Math.hypot(p[0] - q[0], p[2] - q[2])
const r1 = n => Math.round(n * 10) / 10

async function waitUntil (fn, ms) {
  const until = Date.now() + ms
  while (Date.now() < until) { if (await fn()) return true; await sleep(500) }
  return false
}

for (let run = 1; run <= Number(runsArg); run++) {
  // ---- set up ----
  const s0 = await status()
  if (s0.job?.status === 'running') await request({ type: 'cancel' })
  await waitUntil(async () => (await status()).alive, 30000)
  await rcon(['time set 18000', 'gamerule doDaylightCycle false', 'gamerule doMobSpawning false', 'gamerule mobGriefing false', 'kill @e[type=!player]', `tp ${NAME} ${A.join(' ')} -90 0`, `clear ${NAME}`, `effect clear ${NAME}`,
    `give ${NAME} ${sword}`, `effect give ${NAME} instant_health 1 5`, `effect give ${NAME} saturation 2 10`])
  await sleep(2500)
  const target = Number(healthArg)
  if (target < 20) { await rcon([`damage ${NAME} ${20 - target} minecraft:generic`]); await sleep(1000) }
  // Take what the set-up or the last run woke, so the report after the run is about the fight.
  if ((await status()).pending) await request({ type: 'wait' })
  let runMsgs = []
  let jobEnd = null
  if (mode === 'goto') {
    request({ type: 'run', file: path.join(dir, 'tasks/patrol.mjs'), args: [...A, ...B, LEGS].map(String) }, m => {
      if (m.type === 'log' || m.type === 'event') runMsgs.push(m.line ?? m.text)
      if (m.type === 'result') jobEnd = m.summary.end
    })
    await sleep(500)
  }
  // ---- fight ----
  const v0 = await vitals()
  const start = v0.position
  await rcon(MOBS[mob].summon)
  const t0 = Date.now()
  const seen = []
  const acts = [] // what the bot was doing, sample by sample: pvp target, a Pathfinder goal
  let hmin = v0.health
  let maxDist = 0
  let died = false
  let calmSince = null
  let samples = 0
  while (Date.now() - t0 < 150000) {
    await sleep(500)
    const s = await status()
    const ctrl = s.controller ? `${s.controller.kind}:${s.controller.name}${s.controller.phase !== 'running' ? `(${s.controller.phase})` : ''}` : 'none'
    if (seen.at(-1) !== ctrl) seen.push(ctrl)
    if (!s.alive) { died = true; break }
    const v = await vitals()
    if (!v) continue
    const act = `${ctrl}${v.pvpTarget ? ' pvp' : ''}${v.goal ? ' goal' : ''}`
    if (acts.at(-1) !== act) acts.push(act)
    samples++
    hmin = Math.min(hmin, v.health)
    maxDist = Math.max(maxDist, dist(v.position, start))
    const left = await mobCount()
    // Over when every mob is gone and no reflex is fighting for 2 s; a goto
    // job still walking is cancelled at the next set-up.
    if (left === 0 && s.controller?.kind !== 'reflex') { calmSince ??= Date.now(); if (Date.now() - calmSince > 2000) break } else calmSince = null
  }
  const seconds = r1((Date.now() - t0) / 1000)
  const v1 = died ? null : await vitals()
  const left = await mobCount()
  if (died) await waitUntil(async () => (await status()).alive, 30000)
  await sleep(1000)
  // Only when something woke: a wait with nothing pending would block.
  const report = (await status()).pending ? (await request({ type: 'wait' }))?.text ?? '' : '（这一轮没有唤醒）'
  const row = {
    at: new Date().toISOString(), mob, mode, sword, run, legs: mode === 'goto' ? LEGS : undefined,
    healthStart: r1(v0.health), healthMin: r1(hmin), healthEnd: v1 ? r1(v1.health) : 0, died,
    mobsLeft: left, seconds, maxDistFromStart: r1(maxDist), endDistFromStart: v1 ? r1(dist(v1.position, start)) : null,
    controllers: seen, acts, mobsKilled: MOBS[mob].summon.length - left, jobEnd: jobEnd ?? (mode === 'goto' ? '跑完时仍在进行' : null), runLines: runMsgs.filter(l => l.startsWith('[')).slice(0, 6), samples
  }
  fs.appendFileSync(path.join(dir, 'fight-results.jsonl'), JSON.stringify(row) + '\n')
  fs.appendFileSync(path.join(dir, 'fight-reports.log'), `\n===== ${row.at} ${mob} ${mode} ${sword} ${healthArg} run ${run}\n${report}\n`)
  console.log(JSON.stringify(row))
}
await rcon(['kill @e[type=!player]'])
process.exit(0)
