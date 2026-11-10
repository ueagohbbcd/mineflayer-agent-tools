// Execution-logic tests for game/lib/host.mjs with a stand-in bot (an
// EventEmitter). They check ordering and lifecycle only; whether Pathfinder
// really stops, deaths and real harness behaviour are checked on a server.
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createHost } from '../../game/lib/host.mjs'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function setup (opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-test-'))
  const bot = new EventEmitter()
  bot.health = 20
  bot.entity = { position: { x: 0, y: 64, z: 0 } }
  const events = []
  const cleanupCalls = []
  const host = createHost(bot, {
    dir,
    graceMs: 300,
    log: () => {},
    cleanup: () => { cleanupCalls.push(Date.now()) },
    ...opts
  })
  const file = (name, source) => {
    const p = path.join(dir, `${name}.mjs`)
    fs.writeFileSync(p, source)
    return p
  }
  const run = async (f, args = []) => {
    const msgs = []
    const out = await host.submit(f, { args, sink: m => msgs.push(m) })
    return { out, msgs, result: () => msgs.find(m => m.type === 'result')?.summary }
  }
  return { dir, bot, host, file, run, events, cleanupCalls }
}

const until = async (fn, ms = 3000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (fn()) return
    await sleep(10)
  }
  throw new Error('timed out waiting for condition')
}

test('a task that finishes ends the job, wakes, and wait returns at once', async () => {
  const { host, file, run } = setup()
  const r = await run(file('ok', 'export default async () => 42'))
  await until(() => r.result())
  assert.equal(r.result().ok, true)
  assert.equal(r.result().value, 42)
  assert.equal(host.pending(), true)
  const report = await host.waitForReport()
  assert.match(report, /最近结束的作业：j1-ok 完成/)
  assert.equal(host.pending(), false)
})

test('the job having ended is pending even after its wake flag was consumed', async () => {
  const { host, file, run } = setup()
  const r = await run(file('slow', 'export default async () => { await new Promise(r => setTimeout(r, 100)); return 1 }'))
  host.wake('something else')
  await host.collect() // consumes the wake while the task still runs
  assert.equal(host.pending(), false)
  await until(() => r.result())
  assert.equal(host.pending(), true)
})

test('a wake with no waiter is kept; several wakes merge into one report', async () => {
  const { host } = setup()
  host.wake('chat: hello')
  host.wake('chat: hello again')
  const report = await host.waitForReport()
  assert.match(report, /chat: hello\n/)
  assert.match(report, /chat: hello again/)
  assert.equal(host.pending(), false)
})

test('a wake during report collection is kept for the next wait', async () => {
  const { host } = setup()
  let first = true
  host.addReport('slow', async () => {
    if (first) { first = false; await sleep(50); host.wake('late') }
    return 'x'
  })
  host.wake('early')
  const a = await host.waitForReport()
  assert.match(a, /early/)
  assert.equal(host.pending(), true)
  const b = await host.waitForReport()
  assert.match(b, /late/)
})

test('a waiter that leaves consumes nothing', async () => {
  const { host } = setup()
  const left = new AbortController()
  const p = host.waitForReport(left.signal)
  left.abort()
  assert.equal(await p, null)
  host.wake('after')
  assert.equal(host.pending(), true)
})

test('report functions: a failing one is reported and the others still run', async () => {
  const { host } = setup()
  host.addReport('bad', () => { throw new Error('boom') })
  host.addReport('good', () => 'fine')
  host.wake('x')
  const report = await host.waitForReport()
  assert.match(report, /== bad ==\n报告出错：boom/)
  assert.match(report, /== good ==\nfine/)
})

test('safepoint with then restart: task exits, reflex runs, a new attempt starts from entry; one job, one result', async () => {
  const order = []
  let hungry = true
  const reflexes = {
    eat: {
      check: () => (hungry ? 'food 6' : null),
      run: async () => { order.push('eat'); hungry = false; return 'ate' }
    }
  }
  const { host, file, run } = setup({ reflexes })
  globalThis.__order = order
  const r = await run(file('trip', `export default async (bot, ctx) => {
    globalThis.__order.push('start ' + ctx.attempt)
    try { await ctx.safepoint({ eat: 'restart' }) } finally { globalThis.__order.push('finally ' + ctx.attempt) }
    return 'done'
  }`))
  await until(() => r.result())
  assert.deepEqual(order, ['start 1', 'finally 1', 'eat', 'start 2', 'finally 2'])
  assert.equal(r.result().ok, true)
  assert.equal(r.result().attempts, 2)
  assert.equal(r.msgs.filter(m => m.type === 'result').length, 1)
  assert.ok(r.msgs.some(m => m.type === 'event' && /重跑/.test(m.text)))
  assert.equal(host.job.status, 'ended')
})

test('preempt from an observer, then end: the job ends after the reflex, then idle', async () => {
  const order = []
  const reflexes = { defend: { run: async () => { order.push('defend'); await sleep(30); return 'safe' } } }
  const idle = async (bot, ctx) => { order.push('idle'); await new Promise(resolve => ctx.signal.addEventListener('abort', resolve)) }
  const { host, file, run } = setup({ reflexes, idle })
  const r = await run(file('mine', `export default async (bot, ctx) => {
    await new Promise((resolve, reject) => ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason)))
  }`))
  await sleep(20)
  assert.equal(host.preempt('defend', { reason: 'skeleton' }).ok, true)
  assert.equal(r.result(), undefined, 'submit still follows while the reflex runs')
  await until(() => r.result())
  assert.equal(r.result().preemptedBy, 'defend')
  assert.match(r.result().reflex, /safe/)
  await until(() => host.controller?.kind === 'idle')
  assert.deepEqual(order, ['defend', 'idle'])
})

test('a second preempt while one is running is refused', async () => {
  const reflexes = {
    a: { run: async () => sleep(80) },
    b: { run: async () => {} }
  }
  const { host } = setup({ reflexes })
  assert.equal(host.preempt('a').ok, true)
  assert.equal(host.preempt('b').ok, false)
})

test('the exit flow runs once even when requested twice', async () => {
  let cleanups = 0
  const { host, file, run } = setup()
  globalThis.__count = () => cleanups++
  const r = await run(file('c', `export default async (bot, ctx) => {
    ctx.cleanup(() => globalThis.__count())
    await new Promise((resolve, reject) => ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason)))
  }`))
  await sleep(20)
  const [a, b] = await Promise.all([host.cancel(), host.cancel()])
  assert.equal(a.ok, true)
  assert.equal(b.ok, true)
  await until(() => r.result())
  assert.equal(cleanups, 1)
  assert.equal(r.result().ended, 'cancelled')
})

test('a task that ignores the exit keeps control: nothing else starts, the model is woken, then things proceed', async () => {
  const order = []
  const reflexes = { defend: { run: async () => { order.push('defend'); return 'ran' } } }
  const { host, file, run } = setup({ reflexes })
  const r = await run(file('stubborn', `export default async (bot, ctx) => {
    ctx.log('digging the last block')
    await new Promise(r => setTimeout(r, 1500)); return "late"
  }`))
  await sleep(20)
  const t = host.preempt('defend', { reason: 'x' })
  assert.equal(await t.done, false)
  assert.equal(host.controller.kind, 'task')
  assert.equal(host.controller.phase, 'stuck')
  assert.equal(host.preempt('defend').ok, false, 'no second request while stuck')
  const report = await host.waitForReport()
  assert.match(report, /没有退出，仍占着角色；它最后输出的一行：digging the last block/)
  assert.match(report, /每次 await 之后检查 ctx\.signal\.aborted，为真就返回/)
  assert.deepEqual(order, [])
  assert.equal(r.result(), undefined)
  // When it finally returns, the queued reflex runs as usual and the model hears of it.
  await until(() => r.result(), 3000)
  assert.deepEqual(order, ['defend'])
  assert.equal(r.result().preemptedBy, 'defend')
  assert.match(await host.waitForReport(), /终于退出了/)
})

test('a cancel while stuck ends the job as cancelled once the task finally exits', async () => {
  const { host, file, run } = setup()
  const r = await run(file('stubborn2', 'export default async () => { await new Promise(r => setTimeout(r, 800)); return "late" }'))
  await sleep(20)
  const c = await host.cancel()
  assert.equal(c.ok, false)
  await until(() => r.result(), 3000)
  assert.equal(r.result().ended, 'cancelled')
})

test('preempt then cancel before the task has exited: the reflex never starts, idle follows', async () => {
  const order = []
  const reflexes = { defend: { run: async () => { order.push('defend'); await sleep(200); return 'safe' } } }
  const idle = async (bot, ctx) => { order.push('idle'); await new Promise(resolve => ctx.signal.addEventListener('abort', resolve)) }
  const { host, file, run } = setup({ reflexes, idle })
  await until(() => host.controller?.kind === 'idle')
  order.length = 0
  // Leaves 50 ms after the exit request, so cancel arrives while it is exiting.
  const r = await run(file('slowexit', `export default async (bot, ctx) => {
    await new Promise(resolve => ctx.signal.addEventListener('abort', () => setTimeout(resolve, 50)))
  }`))
  await sleep(20)
  assert.equal(host.preempt('defend', { reason: 'zombie' }).ok, true)
  const c = await host.cancel()
  assert.equal(c.ok, true)
  assert.equal(r.result().ended, 'cancelled')
  await until(() => host.controller?.kind === 'idle')
  await sleep(100)
  assert.deepEqual(order, ['idle'])
  assert.equal(host.controller.kind, 'idle')
})

test('cancel while a reflex holds the job ends the reflex and the job, then idle', async () => {
  const order = []
  const reflexes = {
    defend: { run: async (bot, ctx) => { order.push('defend'); await new Promise(resolve => ctx.signal.addEventListener('abort', resolve)); order.push('defend left') } }
  }
  const idle = async (bot, ctx) => { order.push('idle'); await new Promise(resolve => ctx.signal.addEventListener('abort', resolve)) }
  const { host, file, run } = setup({ reflexes, idle })
  await until(() => host.controller?.kind === 'idle')
  order.length = 0
  const r = await run(file('held', `export default async (bot, ctx) => {
    await new Promise((resolve, reject) => ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason)))
  }`))
  await sleep(20)
  host.preempt('defend', { reason: 'zombie' })
  await until(() => host.controller?.kind === 'reflex')
  const c = await host.cancel()
  assert.equal(c.ok, true)
  assert.equal(r.result().ended, 'cancelled')
  await until(() => host.controller?.kind === 'idle')
  assert.deepEqual(order, ['defend', 'defend left', 'idle'])
})

test('submitting a new job while a preempt is queued replaces it; the reflex never starts', async () => {
  const order = []
  const reflexes = { defend: { run: async () => { order.push('defend') } } }
  const { host, file, run } = setup({ reflexes })
  const a = await run(file('a2', `export default async (bot, ctx) => {
    await new Promise(resolve => ctx.signal.addEventListener('abort', () => setTimeout(resolve, 50)))
  }`))
  await sleep(20)
  host.preempt('defend')
  const b = await run(file('b2', 'export default async () => "b"'))
  assert.equal(b.out.ok, true)
  await until(() => b.result())
  assert.equal(a.result().ended, 'replaced')
  assert.deepEqual(order, [])
})

test('death while a preempt is queued: the reflex never starts, no idle before respawn', async () => {
  const order = []
  const reflexes = { defend: { run: async () => { order.push('defend') } } }
  const idle = async (bot, ctx) => { order.push('idle'); await new Promise(resolve => ctx.signal.addEventListener('abort', resolve)) }
  const { host, bot, file, run } = setup({ reflexes, idle })
  await until(() => host.controller?.kind === 'idle')
  order.length = 0
  const r = await run(file('dies', `export default async (bot, ctx) => {
    await new Promise(resolve => ctx.signal.addEventListener('abort', () => setTimeout(resolve, 50)))
  }`))
  await sleep(20)
  host.preempt('defend')
  bot.health = 0
  bot.emit('death')
  await until(() => r.result())
  assert.equal(r.result().ended, 'death')
  await sleep(100)
  assert.equal(host.controller, null)
  assert.deepEqual(order, [])
})

test('client leaving does not cancel; explicit cancel does', async () => {
  const { host, file } = setup()
  const msgs = []
  const sink = m => msgs.push(m)
  await host.submit(file('long', `export default async (bot, ctx) => {
    await new Promise((resolve, reject) => ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason)))
  }`), { sink })
  host.job.sinks.delete(sink) // what the socket server does when the client goes
  await sleep(30)
  assert.equal(host.job.status, 'running')
  await host.cancel()
  assert.equal(host.job.status, 'ended')
  assert.equal(host.job.result.ended, 'cancelled')
})

test('submitting a new job replaces the running one through the exit flow', async () => {
  const { host, file, run } = setup()
  const a = await run(file('a', `export default async (bot, ctx) => {
    await new Promise((resolve, reject) => ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason)))
  }`))
  await sleep(10)
  const b = await run(file('b', 'export default async () => "b"'))
  await until(() => b.result())
  assert.equal(a.result().ended, 'replaced')
  assert.equal(b.result().ok, true)
})

test('death ends the job, cancels a pending restart, and a late reflex end restarts nothing', async () => {
  const reflexes = {
    eat: {
      check: () => 'hungry',
      // Finishes a moment after its exit is requested: a late completion.
      run: (bot, ctx) => new Promise(resolve => ctx.signal.addEventListener('abort', () => setTimeout(() => resolve('ate late'), 50)))
    }
  }
  const idle = async (bot, ctx) => new Promise(resolve => ctx.signal.addEventListener('abort', resolve))
  const { host, bot, file, run } = setup({ reflexes, idle })
  globalThis.__starts = 0
  const r = await run(file('d', `export default async (bot, ctx) => {
    globalThis.__starts++
    await ctx.safepoint({ eat: 'restart' })
  }`))
  await until(() => host.controller?.kind === 'reflex')
  bot.health = 0
  bot.emit('death')
  await until(() => r.result())
  assert.equal(r.result().ended, 'death')
  await sleep(100)
  assert.equal(globalThis.__starts, 1)
  assert.equal(host.controller, null, 'no idle before respawn')
  bot.health = 20
  bot.emit('spawn')
  await until(() => host.controller?.kind === 'idle')
  assert.match(await host.waitForReport(), /重生/)
})

test('a task that throws ends the job with the error and returns to idle', async () => {
  const idle = async (bot, ctx) => new Promise(resolve => ctx.signal.addEventListener('abort', resolve))
  const { host, file, run } = setup({ idle })
  const r = await run(file('bad', 'export default async () => { throw new Error("oops") }'))
  await until(() => r.result())
  assert.equal(r.result().ok, false)
  assert.match(r.result().error, /oops/)
  await until(() => host.controller?.kind === 'idle')
})

test('a host created after spawn starts idle by itself', async () => {
  const idle = async (bot, ctx) => new Promise(resolve => ctx.signal.addEventListener('abort', resolve))
  const { host } = setup({ idle })
  await until(() => host.controller?.kind === 'idle')
})

// ---- onEvent: the order of what an observer keeping a timeline receives ----
function withEvents (opts = {}) {
  const got = []
  const idle = async (bot, ctx) => new Promise(resolve => ctx.signal.addEventListener('abort', resolve))
  const s = setup({ idle, onEvent: e => got.push(e), ...opts })
  const seen = () => got.map(e => e.type + (e.kind ? `:${e.kind}` : ''))
  return { ...s, got, seen }
}

test('onEvent: a finished job, then a wait', async () => {
  const { host, file, run, got, seen } = withEvents()
  await until(() => host.controller?.kind === 'idle')
  got.length = 0
  const r = await run(file('ok', 'export default async () => 42'))
  await until(() => host.controller?.kind === 'idle' && r.result())
  await host.waitForReport()
  assert.deepEqual(seen(), ['job', 'settle:idle', 'control:task', 'settle:task', 'job_end', 'wake', 'control:idle', 'report'])
  assert.deepEqual(got[0].args, [])
  assert.equal(got[2].attempt, 1)
  assert.equal(got[4].ok, true)
  assert.equal(got[4].end, '完成')
  assert.match(got[7].text, /j1-ok 完成/)
  assert.equal(got[7].waiters, 1)
})

test('onEvent: a preempt with then end', async () => {
  const reflexes = { defend: { run: async () => { await sleep(20); return 'safe' } } }
  const { host, file, run, got, seen } = withEvents({ reflexes })
  await until(() => host.controller?.kind === 'idle')
  got.length = 0
  const r = await run(file('mine', `export default async (bot, ctx) => {
    await new Promise((resolve, reject) => ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason)))
  }`))
  await sleep(20)
  host.preempt('defend', { reason: 'zombie' })
  await until(() => host.controller?.kind === 'idle' && r.result())
  assert.deepEqual(seen(), ['job', 'settle:idle', 'control:task', 'preempt', 'wake', 'settle:task', 'control:reflex', 'settle:reflex', 'job_end', 'wake', 'control:idle'])
  const p = got[3]
  assert.deepEqual([p.reflex, p.then, p.reason, p.by, p.job], ['defend', 'end', 'zombie', 'observer', 'j1-mine'])
  assert.match(got[7].outcome, /safe/)
  assert.equal(got[8].preemptedBy, 'defend')
})

test('onEvent: cancel', async () => {
  const { host, file, run, got, seen } = withEvents()
  await until(() => host.controller?.kind === 'idle')
  got.length = 0
  const r = await run(file('long', `export default async (bot, ctx) => {
    await new Promise((resolve, reject) => ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason)))
  }`))
  await sleep(10)
  await host.cancel()
  await until(() => host.controller?.kind === 'idle' && r.result())
  assert.deepEqual(seen(), ['job', 'settle:idle', 'control:task', 'settle:task', 'job_end', 'wake', 'control:idle'])
  assert.match(got[3].outcome, /已取消/)
  assert.equal(got[4].ended, 'cancelled')
})

test('onEvent: death and respawn', async () => {
  const { host, bot, file, run, got, seen } = withEvents()
  await until(() => host.controller?.kind === 'idle')
  got.length = 0
  const r = await run(file('walk', `export default async (bot, ctx) => {
    await new Promise((resolve, reject) => ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason)))
  }`))
  await sleep(10)
  bot.health = 0
  bot.emit('death')
  await until(() => r.result())
  await sleep(50)
  bot.health = 20
  bot.emit('spawn')
  await until(() => host.controller?.kind === 'idle')
  assert.deepEqual(seen(), ['job', 'settle:idle', 'control:task', 'death', 'wake', 'settle:task', 'job_end', 'wake', 'respawn', 'wake', 'control:idle'])
  assert.deepEqual([got[3].job, got[3].controller, got[3].where], ['j1-walk', 'task j1-walk', '0 64 0'])
  assert.equal(got[6].ended, 'death')
})

test('onEvent: a listener that throws does not disturb the host', async () => {
  const { file, run } = setup({ onEvent: () => { throw new Error('listener') } })
  const r = await run(file('ok', 'export default async () => 1'))
  await until(() => r.result())
  assert.equal(r.result().ok, true)
})
