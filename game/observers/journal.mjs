// SPDX-License-Identifier: MIT
// The game's own timeline, one JSON line per event in records/journal.jsonl:
// the host's events (createHost's onEvent), main starting and stopping (a
// start with no stop before it is a crash), each hit taken, a short state
// line at each job start, job end and death, and the full text of each `wait`
// report. Each new version of a submitted task file is copied to
// records/tasks/<name>-<hash>.mjs; the job's line has the hash either way.
//
//   const journal = startJournal({ bot, dir, damage, plugins })   right after createBot
//   createHost(bot, { ..., onEvent: journal.event })
//   if (journal.previousEnd) host.wake(journal.previousEnd)     the last main crashed
//
// `node report.mjs journal [minutes]` lists the lines; `node report.mjs review`
// sums them up (review.mjs).
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { recordsDir } from '../lib/files.mjs'
import { clock } from './support.mjs'
import { recordLog } from './record.mjs'

export function startJournal ({ bot, dir, damage, plugins = [] }) {
  const log = recordLog(dir, 'journal')
  const post = (type, data) => log.post(data, { type })
  const previousEnd = lastRunEnd(path.join(recordsDir(dir), 'journal.jsonl'))
  post('main_start', { pid: process.pid, toolkit: toolkitVersion(), plugins })
  process.on('exit', code => post('main_stop', { code }))
  damage?.on(hit => post('damage', { cause: hit.type, source: hit.source, health: hit.health }))

  function event ({ type, ...data }) {
    if (type === 'job') Object.assign(data, snapshot(dir, data.file))
    if (type === 'job_end' && data.value !== undefined) data.value = clip(JSON.stringify(data.value), 300)
    if (type === 'settle') data.outcome = clip(data.outcome, 300)
    post(type, data)
    if (type === 'job' || type === 'job_end' || type === 'death') post('state', state(bot))
  }
  return { event, previousEnd }
}

/**
 * How the previous main ended, as a wake reason, when it did not stop
 * cleanly: no main_stop after its main_start (killed, out of memory, power
 * cut) or a non-zero exit code. null after a clean stop or with no journal.
 */
function lastRunEnd (file) {
  let lines
  try { lines = fs.readFileSync(file, 'utf8').trimEnd().split('\n') } catch { return null }
  const start = lines.findLastIndex(l => l.includes('"type":"main_start"'))
  if (start < 0) return null
  const run = lines.slice(start).flatMap(l => { try { return [JSON.parse(l)] } catch { return [] } })
  const stop = run.find(e => e.type === 'main_stop')
  if (stop?.data?.code === 0) return null
  const open = new Set()
  for (const e of run) {
    if (e.type === 'job') open.add(e.data.id)
    if (e.type === 'job_end') open.delete(e.data.id)
  }
  const how = stop ? `after it exited with code ${stop.data.code} at ${clock(stop.at)} UTC` : `after a crash (its last record at ${clock(run.at(-1).at)} UTC)`
  const lost = [...open]
  return `main restarted ${how}; ${lost.length ? `the job ${lost.join(', ')} was lost` : 'no job was running'}; the old main's output may say why`
}

function state (bot) {
  const p = bot.entity?.position
  const inv = {}
  for (const item of bot.inventory?.items?.() ?? []) inv[item.name] = (inv[item.name] ?? 0) + item.count
  return {
    health: Math.round((bot.health ?? 0) * 10) / 10,
    food: bot.food,
    pos: p ? [p.x, p.y, p.z].map(Math.floor).join(' ') : null,
    held: bot.heldItem?.name ?? null,
    time: bot.time?.timeOfDay,
    inv: Object.entries(inv).map(([n, c]) => `${n}:${c}`).join(' ')
  }
}

/** Copies the task file to records/tasks/ when this version is new there. */
function snapshot (dir, file) {
  let source
  try { source = fs.readFileSync(file) } catch { return {} }
  const hash = crypto.createHash('sha1').update(source).digest('hex').slice(0, 8)
  const ext = path.extname(file)
  const rel = path.join('tasks', `${path.basename(file, ext)}-${hash}${ext}`)
  const abs = path.join(recordsDir(dir), rel)
  if (fs.existsSync(abs)) return { hash }
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, source)
  return { hash, snapshot: path.join('records', rel) }
}

function toolkitVersion () {
  const root = new URL('../../', import.meta.url)
  const out = {}
  try { out.version = JSON.parse(fs.readFileSync(new URL('package.json', root), 'utf8')).version } catch {}
  try {
    let head = fs.readFileSync(new URL('.git/HEAD', root), 'utf8').trim()
    if (head.startsWith('ref: ')) head = fs.readFileSync(new URL(`.git/${head.slice(5)}`, root), 'utf8').trim()
    out.commit = head.slice(0, 10)
  } catch {}
  return out
}

const clip = (s, n) => (typeof s === 'string' && s.length > n ? `${s.slice(0, n)}…` : s)
const who = d => ({ task: `task ${d.name}`, reflex: `reflex ${d.name}`, idle: 'idle' }[d.kind] ?? d.name)

/** One short line for a journal entry (without the time). */
export function journalText ({ type, data: d = {} }) {
  switch (type) {
    case 'main_start': return `main started (pid ${d.pid}${d.toolkit?.commit ? `, toolkit ${d.toolkit.commit}` : ''})`
    case 'main_stop': return `main stopped (exit code ${d.code})`
    case 'job': return `submitted ${d.id} (${path.basename(d.file ?? '')}${d.args?.length ? ` ${d.args.join(' ')}` : ''}, version ${d.hash ?? '?'}${d.snapshot ? ', new' : ''})`
    case 'control': return d.kind === 'task' ? `${d.name} attempt ${d.attempt} started` : `${who(d)} started`
    case 'settle': return `${who(d)} ${d.outcome}${d.stuck ? ' (after being stuck)' : ''}`
    case 'preempt': return `${d.reflex} preempts (${d.reason || 'no reason given'}, from ${d.by}, then ${d.then})`
    case 'stuck': return `${who(d)} stuck (${d.why})`
    case 'job_end': return `job ${d.id} ${d.end} (${d.seconds} s, ${d.attempts} ${d.attempts === 1 ? 'attempt' : 'attempts'})`
    case 'death': return `died at ${d.where} (${d.controller ?? 'no controller'})`
    case 'respawn': return `respawned at ${d.where}`
    case 'wake': return `wake: ${d.reason ?? ''}`
    case 'report': return `wait got the report (${d.text?.length ?? 0} characters)`
    case 'damage': return `hurt ${d.cause}${d.source ? ` (${d.source})` : ''}, health ${d.health}`
    case 'state': return `state: health ${d.health} food ${d.food} at ${d.pos} held ${d.held ?? 'nothing'}${d.inv ? ` inventory ${clip(d.inv, 60)}` : ''}`
    default: return `${type} ${JSON.stringify(d)}`
  }
}

/** `node report.mjs journal`: one line per entry. */
export function summarize (entries) {
  return entries.map(e => `${clock(e.at)} ${journalText(e)}`)
}
