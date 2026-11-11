// SPDX-License-Identifier: MIT
// One page about a game, computed from records/journal.jsonl alone (pure
// functions; `node report.mjs review [minutes] [--json]` calls them):
//
//   const r = review(entries)   the numbers, the same as --json prints
//   formatReview(r)             the page
import path from 'node:path'
import { clock } from './support.mjs'
import { journalText } from './journal.mjs'

const LEAD_MS = 60000
const LONG_JOB_S = 180
const CATEGORIES = ['done', 'failed', 'cancelled', 'replaced', 'preempted', 'died', 'main exited']

export function category (s) {
  if (s.ok) return 'done'
  if (s.ended === 'death') return 'died'
  if (s.ended === 'cancelled') return 'cancelled'
  if (s.ended === 'replaced') return 'replaced'
  if (s.preemptedBy) return 'preempted'
  return 'failed'
}

export function review (entries) {
  const t = e => Date.parse(e.at)
  const r = {
    from: entries[0]?.at ?? null,
    to: entries.at(-1)?.at ?? null,
    seconds: 0,
    starts: 0,
    crashes: [], // { startedAt, lastAt }: a main start with no stop after it
    exits: [], // { at, code } stops with a code other than 0
    running: false, // the last start has no stop (running now, or crashed)
    deaths: [],
    jobs: { total: 0, byEnd: Object.fromEntries(CATEGORIES.map(c => [c, 0])), firstStartSeconds: null, firstOwn: null, firstRunFailed: [], long: [], stuck: [] },
    control: { task: 0, reflex: 0, idle: 0, none: 0 },
    preempts: [],
    reports: { delivered: 0, longestUnread: null },
    damage: {}
  }
  if (!entries.length) return r
  r.seconds = s(t(entries.at(-1)) - t(entries[0]))

  const jobs = [] // in order of submission
  let run = 0
  let open = false // a main start not closed by a stop
  let firstStart = null
  let current = null // the running job
  let ctrl = null // { kind, since }
  let lastAt = t(entries[0])
  let unread = [] // job ends since the last report
  const hits = []
  const byKey = new Map()
  const seenFiles = new Set()

  const closeRun = at => {
    if (ctrl) r.control[ctrl.kind] += at - ctrl.since
    ctrl = null
    if (current && !current.end) { current.end = { category: 'main exited' }; current.endedAt = at }
    current = null
  }

  for (const [i, e] of entries.entries()) {
    const at = t(e)
    const d = e.data ?? {}
    switch (e.type) {
      case 'main_start':
        if (open) { r.crashes.push({ startedAt: open, lastAt: new Date(lastAt).toISOString() }); closeRun(lastAt) }
        run++
        r.starts++
        open = e.at
        firstStart ??= at
        break
      case 'main_stop':
        closeRun(at)
        open = false
        if (d.code !== 0) r.exits.push({ at: e.at, code: d.code })
        break
      case 'job': {
        const j = { id: d.id, file: d.file, hash: d.hash, at: e.at, submittedAt: at, run }
        jobs.push(j)
        byKey.set(`${run}:${d.id}`, j)
        break
      }
      case 'control':
        if (ctrl) r.control[ctrl.kind] += at - ctrl.since
        ctrl = { kind: d.kind, since: at }
        if (d.kind === 'task') {
          current = byKey.get(`${run}:${d.job}`) ?? null
          if (d.attempt === 1 && r.jobs.firstStartSeconds === null && firstStart !== null) r.jobs.firstStartSeconds = s(at - firstStart)
        }
        break
      case 'settle':
        if (ctrl) r.control[ctrl.kind] += at - ctrl.since
        ctrl = null
        if (d.kind === 'reflex') {
          const p = r.preempts.findLast(p => p.reflex === d.name && p.outcome === null)
          if (p) p.outcome = d.outcome
        }
        if (d.stuck) {
          const st = r.jobs.stuck.findLast(x => x.name === d.name && !x.exitedAt)
          if (st) st.exitedAt = e.at
        }
        break
      case 'preempt':
        r.preempts.push({ at: e.at, reflex: d.reflex, reason: d.reason, by: d.by, then: d.then, job: d.job ?? null, run, outcome: null, jobEnd: null })
        break
      case 'stuck':
        r.jobs.stuck.push({ at: e.at, name: d.name, why: d.why, last: d.last ?? null, exitedAt: null })
        break
      case 'job_end': {
        const j = byKey.get(`${run}:${d.id}`)
        if (j) { j.end = { category: category(d), word: d.end, error: d.error, seconds: d.seconds, attempts: d.attempts }; j.endedAt = at }
        if (current === j) current = null
        for (const p of r.preempts) if (p.job === d.id && p.run === run && !p.jobEnd) p.jobEnd = d.end
        unread.push({ id: d.id, at })
        break
      }
      case 'report':
        r.reports.delivered++
        for (const u of unread) longest(r, u, at, true)
        unread = []
        break
      case 'damage': {
        const key = d.cause
        const g = (r.damage[key] ??= { count: 0, sources: {} })
        g.count++
        if (d.source) g.sources[d.source] = (g.sources[d.source] ?? 0) + 1
        hits.push({ at, cause: d.cause, source: d.source ?? null })
        break
      }
      case 'death':
        r.deaths.push({
          at: e.at,
          where: d.where,
          job: d.job ?? null,
          controller: d.controller ?? null,
          atMs: at,
          lead: leadLines(entries.slice(0, i).filter(x => t(x) >= at - LEAD_MS))
        })
        break
    }
    lastAt = at
  }
  if (open) r.running = true
  // The lethal hit is journaled a moment after the death (its health is read later).
  for (const d of r.deaths) {
    const hit = hits.findLast(h => h.at <= d.atMs + 1000 && h.at >= d.atMs - 10000)
    d.cause = hit ? { cause: hit.cause, source: hit.source } : null
    delete d.atMs
  }
  if (ctrl) r.control[ctrl.kind] += lastAt - ctrl.since
  for (const u of unread) longest(r, u, lastAt, false)

  const span = t(entries.at(-1)) - t(entries[0])
  r.control.none = span - r.control.task - r.control.reflex - r.control.idle
  for (const k of Object.keys(r.control)) r.control[k] = s(r.control[k])

  r.jobs.total = jobs.length
  for (const j of jobs) {
    const end = j.end ?? { category: 'running' }
    if (end.category in r.jobs.byEnd) r.jobs.byEnd[end.category]++
    const brief = { id: j.id, at: j.at, file: path.basename(j.file ?? ''), end: end.word ?? end.category, error: end.error ?? null }
    if (!seenFiles.has(j.file)) {
      seenFiles.add(j.file)
      if (end.category === 'failed') r.jobs.firstRunFailed.push(brief)
      if (!r.jobs.firstOwn && path.basename(j.file ?? '') !== 'example.mjs') r.jobs.firstOwn = { ...brief, ok: end.category === 'done' }
    }
    const seconds = end.seconds ?? (j.endedAt ? s(j.endedAt - j.submittedAt) : null)
    if (seconds > LONG_JOB_S) r.jobs.long.push({ ...brief, seconds })
  }
  for (const p of r.preempts) delete p.run
  return r
}

const s = ms => Math.round(ms / 100) / 10

function longest (r, u, at, read) {
  const gap = s(at - u.at)
  if (!r.reports.longestUnread || gap > r.reports.longestUnread.seconds) r.reports.longestUnread = { job: u.id, endedAt: new Date(u.at).toISOString(), seconds: gap, read }
}

/** The 60 s before a death, one line each: hits in a row fold into one; wakes that echo the line before are left out. */
function leadLines (entries) {
  const lines = []
  let prev = null
  let hits = null
  for (const e of entries) {
    const at = Date.parse(e.at)
    const echo = e.type === 'wake' && prev && prev.type !== 'wake' && at - Date.parse(prev.at) <= 20
    prev = e
    // idle starting and stopping, and a first attempt right after its submission, add nothing here.
    if (echo || e.data?.kind === 'idle' || (e.type === 'control' && e.data?.attempt === 1)) continue
    const d = e.data ?? {}
    if (e.type === 'damage' && hits && hits.cause === d.cause && hits.source === d.source) {
      hits.count++
      hits.to = d.health
      lines[lines.length - 1] = hitLine(hits)
      continue
    }
    hits = e.type === 'damage' ? { at: e.at, cause: d.cause, source: d.source, count: 1, from: d.health, to: d.health } : null
    lines.push(hits ? hitLine(hits) : `${clock(e.at)} ${journalText(e)}`)
  }
  return lines
}

const hitLine = h => `${clock(h.at)} hurt ${h.cause}${h.source ? ` (${h.source})` : ''}${h.count > 1 ? `×${h.count}, health ${h.from}→${h.to}` : `, health ${h.to}`}`

const pct = (n, total) => (total ? `${Math.round(n / total * 100)}%` : '-')
const MAX_LEAD = 8

export function formatReview (r) {
  if (!r.from) return 'The journal has no entries (records/journal.jsonl). It is written once main runs with the journal observer.'
  const out = []
  out.push(`== Review ${clock(r.from)}–${clock(r.to)} (${Math.round(r.seconds / 60)} min, times in UTC) ==`)

  const times = n => `${n} ${n === 1 ? 'time' : 'times'}`
  const crash = r.crashes.length ? `, crashed ${times(r.crashes.length)} (no stop recorded after ${r.crashes.map(c => clock(c.lastAt)).join(', ')})` : ', no crashes'
  const exits = r.exits.length ? `, nonzero exits ${r.exits.map(x => `${clock(x.at)} (${x.code})`).join(', ')}` : ''
  out.push(`1. Overview: main started ${times(r.starts)}${crash}${exits}${r.running ? ', the last start is still running or crashed' : ''}; died ${times(r.deaths.length)}`)

  out.push(`2. Deaths:${r.deaths.length ? '' : ' none'}`)
  for (const d of r.deaths) {
    const cause = d.cause ? `${d.cause.cause}${d.cause.source ? ` (${d.cause.source})` : ''}` : 'no damage recorded in the 10 s before'
    out.push(`  ${clock(d.at)} at ${d.where}, ${cause}; job ${d.job ?? 'none'}, controller ${d.controller ?? 'none'}`)
    const lead = d.lead.length > MAX_LEAD ? [`…${d.lead.length - MAX_LEAD} earlier lines`, ...d.lead.slice(-MAX_LEAD)] : d.lead
    for (const line of lead) out.push(`    ${line}`)
  }

  const j = r.jobs
  const ends = Object.entries(j.byEnd).filter(([, n]) => n).map(([c, n]) => `${c} ${n}`).join(', ')
  out.push(`3. Jobs: ${j.total}${ends ? ` (${ends})` : ''}`)
  out.push(`  first job started: ${j.firstStartSeconds === null ? 'none' : `${j.firstStartSeconds} s after main first started`}`)
  out.push(`  first task of your own: ${j.firstOwn ? `${j.firstOwn.id} (${j.firstOwn.file}), ${j.firstOwn.ok ? 'done on its first run' : `first run ${j.firstOwn.end}`}` : 'none'}`)
  out.push(`  failed on the first run:${j.firstRunFailed.length ? '' : ' none'}`)
  for (const f of j.firstRunFailed) out.push(`    ${clock(f.at)} ${f.id}: ${f.error}`)
  out.push(`  longer than 3 minutes: ${j.long.length ? j.long.map(x => `${x.id} (${Math.round(x.seconds)} s, ${x.end})`).join(', ') : 'none'}`)
  out.push(`  stuck: ${j.stuck.length ? j.stuck.map(x => `${clock(x.at)} ${x.name} (${x.why})${x.exitedAt ? `, exited ${clock(x.exitedAt)}` : ', never exited'}`).join('; ') : 'none'}`)

  const c = r.control
  out.push(`4. Controller time: task ${Math.round(c.task)} s (${pct(c.task, r.seconds)}), reflex ${Math.round(c.reflex)} s (${pct(c.reflex, r.seconds)}), idle ${Math.round(c.idle)} s (${pct(c.idle, r.seconds)}), no controller ${Math.round(c.none)} s (${pct(c.none, r.seconds)}: dead, main not running, handovers)`)

  out.push(`5. Reflexes:${r.preempts.length ? '' : ' no preempts'}`)
  for (const p of r.preempts) {
    out.push(`  ${clock(p.at)} ${p.reflex} (${p.reason || 'no reason given'}, from ${p.by}) → ${p.outcome ?? 'did not start'}; ${p.job ? `job ${p.job} ${p.jobEnd ?? 'not ended'}` : 'no job'}`)
  }

  const u = r.reports.longestUnread
  out.push(`6. Reports: wait got ${r.reports.delivered} ${r.reports.delivered === 1 ? 'report' : 'reports'}; longest from a job end to the next report: ${u ? `${Math.round(u.seconds)} s (${u.job}${u.read ? '' : ', still unread at the end of the journal'})` : '-'}`)

  const dmg = Object.entries(r.damage).sort((a, b) => b[1].count - a[1].count)
    .map(([cause, g]) => `${cause} ${g.count}${Object.keys(g.sources).length ? ` (${Object.entries(g.sources).map(([k, n]) => `${k} ${n}`).join(', ')})` : ''}`)
  out.push(`7. Damage: ${dmg.join('; ') || 'none'}`)
  return out.join('\n')
}
