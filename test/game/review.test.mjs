// The review digest is arithmetic over journal lines: a hand-written journal
// in, numbers and a page out. Whether the journal records a real game
// faithfully is checked on a server (game/dev/SCENARIOS.md).
import assert from 'node:assert/strict'
import test from 'node:test'
import { formatReview, review } from '../../game/observers/review.mjs'

const T0 = Date.parse('2026-11-10T08:00:00Z')
const at = s => new Date(T0 + s * 1000).toISOString()
const e = (s, type, data = {}) => ({ at: at(s), type, data })
const ok = (id, seconds) => ({ id, ok: true, end: 'done', seconds, attempts: 1 })

const journal = [
  e(0, 'main_start', { pid: 1 }),
  e(5, 'control', { kind: 'idle', name: 'idle' }),
  e(10, 'job', { id: 'j1-example', file: '/p/tasks/example.mjs', args: [], hash: 'aaaa' }),
  e(10, 'settle', { kind: 'idle', name: 'idle', outcome: 'exited (a new job starts)' }),
  e(10, 'control', { kind: 'task', name: 'j1-example', job: 'j1-example', attempt: 1 }),
  e(14, 'settle', { kind: 'task', name: 'j1-example', outcome: 'ended: {}' }),
  e(14, 'job_end', ok('j1-example', 4)),
  e(14, 'wake', { reason: 'job j1-example done' }),
  e(14, 'control', { kind: 'idle', name: 'idle' }),
  e(20, 'report', { text: 'r1', waiters: 1 }),
  e(30, 'job', { id: 'j2-dig', file: '/p/tasks/dig.mjs', args: [], hash: 'bbbb', snapshot: 'records/tasks/dig-bbbb.mjs' }),
  e(30, 'settle', { kind: 'idle', name: 'idle', outcome: 'exited (a new job starts)' }),
  e(30, 'control', { kind: 'task', name: 'j2-dig', job: 'j2-dig', attempt: 1 }),
  e(31, 'settle', { kind: 'task', name: 'j2-dig', outcome: 'error: boom' }),
  e(31, 'job_end', { id: 'j2-dig', ok: false, error: 'boom', end: 'failed: boom', seconds: 1, attempts: 1 }),
  e(31, 'control', { kind: 'idle', name: 'idle' }),
  e(100, 'report', { text: 'r2', waiters: 1 }),
  e(110, 'job', { id: 'j3-dig', file: '/p/tasks/dig.mjs', args: [], hash: 'cccc', snapshot: 'records/tasks/dig-cccc.mjs' }),
  e(110, 'settle', { kind: 'idle', name: 'idle', outcome: 'exited (a new job starts)' }),
  e(110, 'control', { kind: 'task', name: 'j3-dig', job: 'j3-dig', attempt: 1 }),
  e(115, 'damage', { cause: 'mob_attack', source: 'zombie', health: 15 }),
  e(116, 'damage', { cause: 'mob_attack', source: 'zombie', health: 10 }),
  e(116, 'preempt', { reflex: 'fightOrFlee', then: 'end', reason: 'hit by zombie, health 10', by: 'observer', job: 'j3-dig' }),
  e(116, 'wake', { reason: 'fightOrFlee preempts' }),
  e(116, 'settle', { kind: 'task', name: 'j3-dig', outcome: 'exited (preempt: fightOrFlee)' }),
  e(116, 'control', { kind: 'reflex', name: 'fightOrFlee', job: 'j3-dig' }),
  e(126, 'settle', { kind: 'reflex', name: 'fightOrFlee', outcome: 'ended: nothing hostile nearby' }),
  e(126, 'job_end', { id: 'j3-dig', ok: false, preemptedBy: 'fightOrFlee', reason: 'hit by zombie, health 10', end: 'ended after fightOrFlee preempted it (hit by zombie, health 10)', seconds: 16, attempts: 1 }),
  e(126, 'control', { kind: 'idle', name: 'idle' }),
  e(130, 'job', { id: 'j4-walk', file: '/p/tasks/walk.mjs', args: ['1'], hash: 'dddd' }),
  e(130, 'settle', { kind: 'idle', name: 'idle', outcome: 'exited (a new job starts)' }),
  e(130, 'control', { kind: 'task', name: 'j4-walk', job: 'j4-walk', attempt: 1 }),
  e(140, 'death', { where: '1 2 3', job: 'j4-walk', controller: 'task j4-walk' }),
  e(140.1, 'damage', { cause: 'generic_kill', source: null, health: 0 }), // read 100 ms after the hit
  e(140, 'settle', { kind: 'task', name: 'j4-walk', outcome: 'exited (death)' }),
  e(140, 'job_end', { id: 'j4-walk', ok: false, ended: 'death', where: '1 2 3', end: 'ended by death at 1 2 3', seconds: 10, attempts: 1 }),
  e(145, 'respawn', { where: '0 64 0' }),
  e(145, 'control', { kind: 'idle', name: 'idle' }),
  e(150, 'job', { id: 'j5-walk', file: '/p/tasks/walk.mjs', args: ['2'], hash: 'dddd' }),
  e(150, 'control', { kind: 'task', name: 'j5-walk', job: 'j5-walk', attempt: 1 }),
  e(160, 'main_start', { pid: 2 }),
  e(165, 'control', { kind: 'idle', name: 'idle' }),
  e(170, 'report', { text: 'r3', waiters: 1 }),
  e(180, 'main_stop', { code: 0 })
]

test('review: overview, deaths, jobs', () => {
  const r = review(journal)
  assert.equal(r.seconds, 180)
  assert.equal(r.starts, 2)
  assert.deepEqual(r.crashes, [{ startedAt: at(0), lastAt: at(150) }])
  assert.equal(r.running, false)
  assert.equal(r.deaths.length, 1)
  const d = r.deaths[0]
  assert.deepEqual([d.where, d.job, d.controller], ['1 2 3', 'j4-walk', 'task j4-walk'])
  assert.deepEqual(d.cause, { cause: 'generic_kill', source: null })
  assert.equal(d.lead[0], '08:01:40 wait got the report (2 characters)', 'only the 60 s before')
  assert.ok(d.lead.includes('08:01:55 hurt mob_attack (zombie)×2, health 15→10'))
  assert.ok(!d.lead.some(l => /wake: fightOrFlee/.test(l)), 'a wake right after the preempt is its echo')

  assert.equal(r.jobs.total, 5)
  assert.deepEqual(r.jobs.byEnd, { done: 1, failed: 1, cancelled: 0, replaced: 0, preempted: 1, died: 1, 'main exited': 1 })
  assert.equal(r.jobs.firstStartSeconds, 10)
  assert.equal(r.jobs.firstOwn.id, 'j2-dig')
  assert.equal(r.jobs.firstOwn.ok, false)
  assert.deepEqual(r.jobs.firstRunFailed.map(f => [f.id, f.error]), [['j2-dig', 'boom']])
  assert.deepEqual(r.jobs.long, [])
})

test('review: controller time, reflexes, reports, damage', () => {
  const r = review(journal)
  assert.deepEqual(r.control, { task: 21, reflex: 10, idle: 124, none: 25 })
  assert.equal(r.preempts.length, 1)
  assert.equal(r.preempts[0].outcome, 'ended: nothing hostile nearby')
  assert.match(r.preempts[0].jobEnd, /ended after fightOrFlee preempted it/)
  assert.equal(r.reports.delivered, 3)
  assert.deepEqual(r.reports.longestUnread, { job: 'j2-dig', endedAt: at(31), seconds: 69, read: true })
  assert.deepEqual(r.damage, { mob_attack: { count: 2, sources: { zombie: 2 } }, generic_kill: { count: 1, sources: {} } })
})

test('review: hits in a row fold into one line before a death', () => {
  const r = review([
    e(0, 'main_start', {}),
    e(10, 'damage', { cause: 'mob_attack', source: 'zombie', health: 15 }),
    e(11, 'damage', { cause: 'mob_attack', source: 'zombie', health: 9 }),
    e(12, 'damage', { cause: 'mob_attack', source: 'zombie', health: 3 }),
    e(13, 'damage', { cause: 'mob_attack', source: 'zombie', health: 0 }),
    e(13, 'death', { where: '5 5 5', job: null, controller: 'idle' }),
    e(13, 'wake', { reason: 'died at 5 5 5' })
  ])
  assert.deepEqual(r.deaths[0].lead, ['08:00:00 main started (pid undefined)', '08:00:10 hurt mob_attack (zombie)×4, health 15→0'])
  assert.equal(r.running, true)
})

test('formatReview: the sections in order', () => {
  const page = formatReview(review(journal))
  const at = ['1. Overview', '2. Deaths', '3. Jobs', '4. Controller time', '5. Reflexes', '6. Reports', '7. Damage'].map(h => page.indexOf(h))
  assert.ok(at.every((n, i) => n >= 0 && (i === 0 || n > at[i - 1])), page)
  assert.match(page, /crashed 1 time /)
  assert.match(page, /failed on the first run:\n {4}08:00:30 j2-dig: boom/)
})
