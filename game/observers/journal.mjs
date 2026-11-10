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
  return { event }
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
const who = d => ({ task: `任务 ${d.name}`, reflex: `反射 ${d.name}`, idle: 'idle' }[d.kind] ?? d.name)

/** One short line for a journal entry (without the time). */
export function journalText ({ type, data: d = {} }) {
  switch (type) {
    case 'main_start': return `main 启动（pid ${d.pid}${d.toolkit?.commit ? `，工具箱 ${d.toolkit.commit}` : ''}）`
    case 'main_stop': return `main 停止（退出码 ${d.code}）`
    case 'job': return `提交 ${d.id}（${path.basename(d.file ?? '')}${d.args?.length ? ` ${d.args.join(' ')}` : ''}，版本 ${d.hash ?? '?'}${d.snapshot ? '，新' : ''}）`
    case 'control': return d.kind === 'task' ? `${d.name} 第 ${d.attempt} 次尝试开始` : `${who(d)} 开始`
    case 'settle': return `${who(d)} ${d.outcome}${d.stuck ? '（卡住之后）' : ''}`
    case 'preempt': return `${d.reflex} 抢占（${d.reason || '无原因'}，来自 ${d.by}，之后 ${d.then}）`
    case 'stuck': return `${who(d)} 卡住（${d.why}）`
    case 'job_end': return `作业 ${d.id} ${d.end}（${d.seconds} 秒，${d.attempts} 次尝试）`
    case 'death': return `死亡 @ ${d.where}（${d.controller ?? '无控制者'}）`
    case 'respawn': return `重生 @ ${d.where}`
    case 'wake': return `唤醒：${d.reason ?? ''}`
    case 'report': return `wait 收到报告（${d.text?.length ?? 0} 字）`
    case 'damage': return `受伤 ${d.cause}${d.source ? `（${d.source}）` : ''}，血 ${d.health}`
    case 'state': return `状态 血 ${d.health} 饥饿 ${d.food} @ ${d.pos} 手持 ${d.held ?? '空'}${d.inv ? ` 背包 ${clip(d.inv, 60)}` : ''}`
    default: return `${type} ${JSON.stringify(d)}`
  }
}

/** `node report.mjs journal`: one line per entry. */
export function summarize (entries) {
  return entries.map(e => `${clock(e.at)} ${journalText(e)}`)
}
