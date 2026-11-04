import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createRuleTable } from '../../game/lib/rules.mjs'
import { markDelivered, notifyModel, readUndelivered } from '../../game/lib/notify.mjs'

function table (rules) {
  const notices = []
  const records = []
  const t = createRuleTable(rules, {
    record: (source, entry) => records.push(entry),
    notify: text => notices.push(text),
    events: { deaths: [], noPath: [] }
  })
  return { t, notices, records }
}
const bot = { entity: { position: { x: 0, y: 0, z: 0 } } }

test('a notice-only rule does not take the tick', () => {
  const { t, notices } = table([{ name: 'warn', check: () => ({ notice: 'hi' }) }])
  assert.equal(t.evaluate(bot, 'steps'), null)
  assert.deepEqual(notices, ['[warn] hi'])
})

test('the first rule with inputs wins; later notices still go out', () => {
  const { t, notices } = table([
    { name: 'a', check: () => ({ inputs: { jump: true } }) },
    { name: 'b', check: () => ({ inputs: { forward: true }, notice: 'b' }) }
  ])
  assert.deepEqual(t.evaluate(bot, 'steps'), { rule: 'a', inputs: { jump: true } })
  assert.deepEqual(notices, ['[b] b'])
})

test('plugin period ignores inputs; a notice is sent once per episode', () => {
  let on = true
  const { t, notices } = table([{ name: 'r', check: () => (on ? { inputs: { jump: true }, notice: 'n' } : null) }])
  assert.equal(t.evaluate(bot, 'plugin'), null)
  t.evaluate(bot, 'plugin')
  on = false
  t.evaluate(bot, 'plugin')
  on = true
  t.evaluate(bot, 'plugin')
  assert.equal(notices.length, 2)
})

test('disable turns off inputs only and is restored at task end', () => {
  const { t, notices } = table([{ name: 'r', check: () => ({ inputs: { jump: true }, notice: 'n' }) }])
  t.disable('r')
  assert.equal(t.evaluate(bot, 'steps'), null)
  assert.equal(notices.length, 1)
  assert.deepEqual(t.endTask().disabled, ['r'])
  assert.equal(t.evaluate(bot, 'steps').rule, 'r')
})

test('idle takeovers are not reported as a task takeover', () => {
  let on = true
  const { t } = table([{ name: 'r', check: () => (on ? { inputs: { jump: true } } : null) }])
  t.evaluate(bot, 'idle')
  on = false
  t.evaluate(bot, 'idle')
  assert.deepEqual(t.endTask().takeovers, [])
})

test('wait sees each notice once, and only complete lines', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notices-'))
  notifyModel(dir, 'one')
  fs.appendFileSync(path.join(dir, '.game/notices.jsonl'), '{"text":"half')
  const first = readUndelivered(dir)
  assert.deepEqual(first.notices.map(n => n.text), ['one'])
  markDelivered(dir, first.end)
  fs.appendFileSync(path.join(dir, '.game/notices.jsonl'), '"}\n')
  assert.deepEqual(readUndelivered(dir).notices.map(n => n.text), ['half'])
})
