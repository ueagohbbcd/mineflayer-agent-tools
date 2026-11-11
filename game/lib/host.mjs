// SPDX-License-Identifier: MIT
// The resident core: one bot, one job (the task file the model submitted,
// followed to its end across attempts), one controller at a time (task,
// reflex or idle), one exit flow, wake and reports. It knows nothing about
// the game; stopping the bot's own actions is the injected `cleanup`.
//
//   const host = createHost(bot, { dir, reflexes, idle, cleanup, onEvent })
//
// reflexes: { name: { check?(bot) → reason|null, run(bot, ctx) } }. A task
// offers safepoints with ctx.safepoint({ name: 'restart' | 'end' }); an
// observer preempts with host.preempt(name, { then, reason }). onEvent(e) gets
// a small plain object at each step ({ type: 'job' | 'control' | 'preempt' |
// 'settle' | 'stuck' | 'job_end' | 'death' | 'respawn' | 'wake' | 'report', ... })
// for an observer that keeps a timeline; what it throws is ignored.
//
// Exit flow, shared by cancel, replace, preempt and death: the requester
// records what comes next (`next`) and the controller's signal aborts → its
// cleanups and the game cleanup run → the controller's promise settles →
// settle() carries out `next`. Nothing else takes the bot before that. A later
// request overrides an earlier one by rank: death > cancel = replace >
// preempt. A controller still running graceMs after the request keeps the bot
// (phase 'stuck') and the model is woken; when it settles at last, settle()
// proceeds as usual. The fallback for one that never settles is restarting the
// process.
import fs from 'node:fs'
import path from 'node:path'
import { describeController, describeNow, endWord, errorText, formatJob, summarizeJob, text } from './describe.mjs'
import { loadDefault } from './query.mjs'

export class ExitRequested extends Error {
  constructor (reason) {
    super(`exit: ${reason}`)
    this.name = 'ExitRequested'
    this.reason = reason
  }
}

const RANK = { preempt: 1, cancel: 2, replace: 2, death: 3 }
const EXIT_RULE = 'after every await, check ctx.signal.aborted and return if it is true'
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

export function createHost (bot, {
  dir,
  reflexes = {},
  idle = null,
  cleanup = () => {},
  graceMs = 5000,
  reportTimeoutMs = 3000,
  log = console.log,
  onEvent = null
} = {}) {
  if (!dir) throw new Error('createHost needs { dir }')
  const emit = (type, fields) => { try { onEvent?.({ type, ...fields }) } catch {} }
  const reports = [] // [name, fn]
  // The controller: { kind: 'task'|'reflex'|'idle', name, job, ac, cleanups,
  // phase: 'running'|'exiting'|'stuck'|'done', why, confirms, then, reason }
  let controller = null
  // What follows the current controller's exit, set by whoever asked for it:
  // { kind, why, end?: result for its job, reflex?: { name, then, reason }, start?: new job }
  let next = null
  let job = null // the current job, or the last one
  let jobSeq = 0
  let endSeq = 0 // jobs that have ended
  let alive = true

  // ---- wake ----------------------------------------------------------------
  let wakeGen = 0
  let consumedGen = 0
  let reportedEndSeq = 0
  let reasons = []
  const waiters = new Set()
  let collecting = null

  function wake (reason) {
    wakeGen++
    emit('wake', { reason })
    if (reason) {
      const line = `[${new Date().toISOString().slice(11, 19)}] ${reason}`
      if (!reasons.some(r => r.slice(11) === line.slice(11))) reasons.push(line)
      if (reasons.length > 8) reasons = reasons.slice(-8)
    }
    if (waiters.size) serveWaiters()
  }

  function pending () {
    return wakeGen > consumedGen || endSeq > reportedEndSeq
  }

  async function collect () {
    const gen = wakeGen
    const ends = endSeq
    const why = reasons
    reasons = []
    const lines = []
    lines.push(why.length ? `Woke because:\n${why.map(r => `  ${r}`).join('\n')}` : 'Woke because: nothing new')
    lines.push(`Now: ${describeNow({ alive, job, controller })}`)
    if (ends > reportedEndSeq && job?.status === 'ended') lines.push(`Last job: ${formatJob(job)}`)
    for (const [name, fn] of reports) {
      try {
        const out = await Promise.race([
          Promise.resolve().then(() => fn(bot)),
          sleep(reportTimeoutMs).then(() => { throw new Error(`no answer within ${reportTimeoutMs / 1000} s`) })
        ])
        if (out) lines.push(`== ${name} ==\n${text(out).trimEnd()}`)
      } catch (error) {
        lines.push(`== ${name} ==\nreport failed: ${errorText(error)}`)
      }
    }
    consumedGen = Math.max(consumedGen, gen)
    reportedEndSeq = Math.max(reportedEndSeq, ends)
    return lines.join('\n')
  }

  function serveWaiters () {
    if (collecting) return
    collecting = (async () => {
      while (waiters.size && pending()) {
        const batch = [...waiters]
        waiters.clear()
        const report = await collect()
        emit('report', { text: report, waiters: batch.length })
        for (const w of batch) w(report)
      }
    })().finally(() => {
      collecting = null
      if (waiters.size && pending()) serveWaiters()
    })
  }

  /** Resolves with the report text once something is pending; null if the signal aborts first. */
  function waitForReport (signal) {
    return new Promise(resolve => {
      const waiter = report => resolve(report)
      waiters.add(waiter)
      signal?.addEventListener('abort', () => { if (waiters.delete(waiter)) resolve(null) }, { once: true })
      if (pending()) serveWaiters()
    })
  }

  // ---- job -----------------------------------------------------------------
  function emitJob (type, value, j = job) {
    if (!j) return
    const msg = { type, ...(typeof value === 'object' && value !== null ? value : { text: value }) }
    for (const sink of j.sinks) {
      try { sink(msg) } catch {}
    }
  }

  function finishJob (j, result) {
    if (j.status === 'ended') return
    j.status = 'ended'
    j.endedAt = Date.now()
    j.result = result
    endSeq++
    const p = bot.entity?.position
    // After a death the bot may already stand at its respawn point; the death
    // position is in the end word instead.
    j.position = p && result.ended !== 'death' ? [p.x, p.y, p.z].map(n => Math.round(n * 10) / 10) : null
    const summary = summarizeJob(j)
    emit('job_end', summary)
    emitJob('result', { summary }, j)
    j.sinks.clear()
    wake(`job ${j.id} ${endWord(j)}`)
  }

  // ---- controllers ---------------------------------------------------------
  async function runCleanups (ctrl) {
    for (const fn of ctrl.cleanups.splice(0).reverse()) {
      try { await fn() } catch (error) { log(`cleanup failed (${ctrl.name}): ${errorText(error)}`) }
    }
    try { await cleanup(bot) } catch (error) { log(`game cleanup failed: ${errorText(error)}`) }
  }

  /** Make `run(ctx, ctrl)` the controller; settle() runs when it settles. */
  function start (kind, name, j, run, extra = {}) {
    const ctrl = { kind, name, job: j, ac: new AbortController(), cleanups: [], phase: 'running', confirms: [], ...extra }
    controller = ctrl
    emit('control', { kind, name, job: j?.id, attempt: kind === 'task' ? j.attempts : undefined })
    const ctx = {
      signal: ctrl.ac.signal,
      cleanup: fn => { ctrl.cleanups.push(fn) },
      wake,
      preempt: (reflex, opts) => preempt(reflex, opts, kind)
    }
    Promise.resolve()
      .then(() => run(ctx, ctrl))
      .then(value => ({ ok: true, value }), error => ({ ok: false, error }))
      .then(outcome => settle(ctrl, outcome))
      .catch(error => log(`handover failed: ${error?.stack ?? error}`))
  }

  /**
   * The exit flow. Records `intent` as what comes next (unless a higher-ranked
   * one is already recorded) and asks the controller to exit once. Resolves
   * true when it has exited and the intent was carried out, false when it has
   * not exited within graceMs.
   */
  function requestExit (intent) {
    if (!next || RANK[intent.kind] >= RANK[next.kind]) next = intent
    const ctrl = controller
    if (!ctrl) {
      proceed(null, null)
      return Promise.resolve(true)
    }
    if (ctrl.phase === 'stuck') return Promise.resolve(false)
    const confirmed = new Promise(resolve => ctrl.confirms.push(resolve))
    if (ctrl.phase === 'running') {
      ctrl.phase = 'exiting'
      ctrl.why = intent.why
      ctrl.ac.abort(new ExitRequested(intent.why))
      runCleanups(ctrl) // stop what it is doing now; again after it settles
      setTimeout(() => markStuck(ctrl), graceMs)
    }
    return confirmed
  }

  function markStuck (ctrl) {
    if (controller !== ctrl || ctrl.phase !== 'exiting') return
    ctrl.phase = 'stuck'
    const last = ctrl.job?.log.at(-1)
    const msg = `${describeController(ctrl)} has not exited ${graceMs / 1000} s after the exit request (${ctrl.why}) and still holds the character` +
      `${last ? `; its last log line: ${last}` : ''}. A task must do this: ${EXIT_RULE}. ` +
      'To recover now, restart main: node game.mjs stop, then start main again.'
    log(msg)
    emit('stuck', { kind: ctrl.kind, name: ctrl.name, why: ctrl.why, last })
    emitJob('event', msg, ctrl.job)
    wake(msg)
    for (const resolve of ctrl.confirms.splice(0)) resolve(false)
  }

  /** Runs once whenever a controller's promise settles, whether or not an exit was requested. */
  async function settle (ctrl, outcome) {
    const asked = ctrl.phase !== 'running'
    const wasStuck = ctrl.phase === 'stuck'
    ctrl.phase = 'done'
    emit('settle', { kind: ctrl.kind, name: ctrl.name, stuck: wasStuck, outcome: asked ? `exited (${ctrl.why})` : outcome.ok ? `ended: ${text(outcome.value ?? 'done')}` : `error: ${errorText(outcome.error)}` })
    await runCleanups(ctrl)
    controller = null
    if (wasStuck) wake(`${describeController(ctrl)} has exited at last`)
    // After an exit request the controller's own outcome (usually the abort)
    // does not matter: the recorded intent decides.
    proceed(ctrl, asked ? null : outcome)
    for (const resolve of ctrl.confirms.splice(0)) resolve(true)
  }

  /**
   * Decides what follows `ctrl` (null when there was no controller): a queued
   * reflex, else a new attempt of the task, else the end of the job; then the
   * replacing job or idle.
   */
  function proceed (ctrl, outcome) {
    const intent = next
    next = null
    const j = ctrl ? ctrl.job : (job?.status === 'running' ? job : null)
    let end = intent?.end ?? null
    let restart = false
    if (ctrl?.kind === 'task' && outcome) {
      end = outcome.ok ? { ok: true, value: outcome.value } : { ok: false, error: errorText(outcome.error) }
    }
    if (ctrl?.kind === 'reflex' && outcome) {
      const after = outcome.ok ? `ended: ${text(outcome.value ?? 'done')}` : `failed: ${errorText(outcome.error)}`
      emitJob('event', `[preempt] ${ctrl.name} ${after}`, j)
      if (!j) wake(`${ctrl.name} ${after}`)
      restart = ctrl.then === 'restart'
      end = { ok: false, preemptedBy: ctrl.name, reason: ctrl.reason, reflex: after }
    }
    const running = j?.status === 'running'

    if (alive && intent?.reflex) return startReflex(intent.reflex, running ? j : null)
    if (alive && restart && running) {
      emitJob('event', `[restart] attempt ${j.attempts + 1}, running the task from the top`, j)
      return startAttempt(j)
    }
    if (running && end) finishJob(j, end)
    if (alive && intent?.start) {
      job = intent.start
      return startAttempt(job)
    }
    if (ctrl?.kind === 'idle' && outcome) return idleEnded(outcome)
    startIdle()
  }

  // ---- tasks, reflexes, idle -------------------------------------------------
  /** One attempt: a run of the job's task file from its entry. */
  function startAttempt (j) {
    j.attempts++
    start('task', j.id, j, async (ctx, ctrl) => {
      const task = await loadDefault(j.file)
      return task(bot, {
        ...ctx,
        args: j.args,
        attempt: j.attempts,
        log: (...parts) => {
          const line = parts.map(text).join(' ')
          j.log.push(line)
          if (j.log.length > 30) j.log.shift()
          emitJob('log', { line }, j)
        },
        safepoint: spec => safepoint(ctrl, spec)
      })
    })
  }

  function startReflex ({ name, then, reason }, j) {
    start('reflex', name, j, ctx => reflexes[name].run(bot, { ...ctx, reason }), { then, reason })
  }

  function startIdle () {
    if (!idle || controller || !alive || job?.status === 'running') return
    start('idle', 'idle', null, ctx => idle(bot, ctx))
  }

  // idle returned or threw by itself: start it again after a pause.
  let idleErrors = 0
  function idleEnded (outcome) {
    if (outcome.ok) return setTimeout(startIdle, 1000)
    idleErrors++
    const msg = `idle failed: ${errorText(outcome.error)}`
    log(msg)
    if (idleErrors <= 3) wake(msg)
    setTimeout(startIdle, 2000)
  }

  /** A safepoint offered by the running task. Throws ExitRequested when a reflex preempts it. */
  async function safepoint (ctrl, spec = {}) {
    if (ctrl.ac.signal.aborted) throw ctrl.ac.signal.reason
    for (const [name, then] of Object.entries(spec)) {
      const reflex = reflexes[name]
      if (!reflex) throw new Error(`no reflex named ${name} (there are: ${Object.keys(reflexes).join(', ') || 'none'})`)
      if (typeof reflex.check !== 'function') continue
      let reason
      try { reason = await reflex.check(bot) } catch (error) { reason = null; log(`reflex ${name} check failed: ${errorText(error)}`) }
      if (reason) {
        preempt(name, { then, reason: text(reason) }, 'safepoint')
        throw new ExitRequested(`preempt: ${name}`)
      }
    }
  }

  /**
   * Hand the bot to a reflex. then 'restart' runs the task again from its
   * entry afterwards (a new attempt); 'end' (the default) ends the job and
   * goes to idle.
   */
  function preempt (name, { then = 'end', reason = '' } = {}, by = 'observer') {
    if (!reflexes[name]) return { ok: false, error: `no reflex named ${name}` }
    if (!alive) return { ok: false, error: 'the character is dead' }
    if (next) return { ok: false, error: `an exit is in progress (${next.why})` }
    if (controller?.kind === 'reflex') return { ok: false, error: `reflex ${controller.name} is in control` }
    const j = controller?.kind === 'task' ? controller.job : null
    const thenWord = !j ? '' : then === 'restart' ? ', then the task runs again from the top' : ', then the job ends and idle takes over'
    const msg = `${name} preempts (${reason || 'no reason given'})${thenWord}`
    log(msg)
    emit('preempt', { reflex: name, then, reason, by, job: j?.id })
    emitJob('event', `[preempt] ${msg}`, j)
    wake(msg)
    const done = requestExit({ kind: 'preempt', why: `preempt: ${name}`, reflex: { name, then, reason } })
    return { ok: true, done }
  }

  /** Submit a task file as the job. A running job is replaced. */
  async function submit (file, { args = [], sink } = {}) {
    if (!alive) return { ok: false, error: 'the character is dead; submit again after respawn' }
    const abs = path.resolve(file)
    if (!fs.existsSync(abs)) return { ok: false, error: `file not found: ${abs}` }
    const j = {
      id: `j${++jobSeq}-${path.basename(abs, path.extname(abs))}`,
      file: abs,
      args,
      attempts: 0,
      status: 'running',
      startedAt: Date.now(),
      log: [],
      sinks: new Set(sink ? [sink] : [])
    }
    emit('job', { id: j.id, file: abs, args })
    const replacing = job?.status === 'running'
    const intent = { kind: 'replace', why: replacing ? 'replaced by a new job' : 'a new job starts', end: { ok: false, ended: 'replaced' }, start: j }
    if (!(await requestExit(intent))) {
      // The new job will not start; the old one ends as cancelled whenever it exits.
      if (next === intent) next = { kind: 'cancel', why: intent.why, end: { ok: false, ended: 'cancelled', reason: 'would not exit for a new job' } }
      return { ok: false, error: `${describeController(controller)} will not exit; main needs a restart` }
    }
    if (job !== j) return { ok: false, error: alive ? 'a later submit or cancel overtook this submit; it did not start' : 'the character is dead; the job did not start' }
    return { ok: true, id: j.id, job: j }
  }

  /** Explicit cancel: the exit flow, and nothing queued runs afterwards. */
  async function cancel (reason = 'cancelled') {
    const j = job?.status === 'running' ? job : null
    if (!j) return { ok: true, note: 'no job running' }
    if (!(await requestExit({ kind: 'cancel', why: reason, end: { ok: false, ended: 'cancelled', reason } }))) {
      return { ok: false, error: `${describeController(controller)} will not exit; main needs a restart` }
    }
    return { ok: true, summary: summarizeJob(j) }
  }

  // ---- death and respawn ----------------------------------------------------
  const here = () => {
    const p = bot.entity?.position
    return p ? [p.x, p.y, p.z].map(Math.floor).join(' ') : '?'
  }
  bot.on('death', () => {
    alive = false
    const where = here()
    emit('death', { where, job: job?.status === 'running' ? job.id : null, controller: controller && `${controller.kind} ${controller.name}` })
    if (controller || job?.status === 'running') {
      requestExit({ kind: 'death', why: 'death', end: { ok: false, ended: 'death', where } })
    }
    wake(`died at ${where}`)
  })
  bot.on('spawn', () => {
    if (alive || (bot.health ?? 20) <= 0) return
    alive = true
    emit('respawn', { where: here() })
    wake(`respawned at ${here()}`)
    setTimeout(startIdle, 500)
  })

  // Created after spawn (the usual case): idle starts now.
  if (bot.entity) setTimeout(startIdle, 0)

  return {
    bot,
    dir,
    wake,
    pending,
    waitForReport,
    collect,
    submit,
    cancel,
    preempt,
    addReport: (name, fn) => { reports.push([name, fn]) },
    status: () => ({
      alive,
      controller: controller && { kind: controller.kind, name: controller.name, phase: controller.phase },
      job: job && summarizeJob(job),
      pending: pending(),
      next: next?.kind ?? null
    }),
    get controller () { return controller },
    get job () { return job }
  }
}
