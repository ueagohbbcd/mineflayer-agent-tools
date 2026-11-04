// SPDX-License-Identifier: MIT
// One ordered rule table, evaluated every physics tick in three periods:
//
//   steps   the first rule that returns inputs takes over this tick;
//           the task step runs when no rule returns inputs
//   plugin  a plugin or native code owns the bot: inputs are ignored,
//           notices still go out (this is the watchdog)
//   idle    between tasks: rule inputs keep the character alive
//
// A rule is { name, check(bot, mem, info) } returning null or
// { inputs?, notice? }. `mem` is the rule's own object, kept across ticks.
// `info` = { period, taking, events } where `taking` says this rule's
// inputs were applied on the previous tick.
//
// Inputs and notices are independent. A takeover is only recorded; a notice
// calls notifyModel once per episode (an episode ends on a tick where the
// rule returns no notice). `disable(name)` turns off a rule's inputs only.
export function createRuleTable (rules, { record, notify, events }) {
  const names = new Set()
  for (const rule of rules) {
    if (!rule?.name || typeof rule.check !== 'function') throw new TypeError('each rule needs a name and check(bot, mem, info)')
    if (names.has(rule.name)) throw new Error(`duplicate rule name ${rule.name}`)
    names.add(rule.name)
  }
  const state = new Map(rules.map(rule => [rule.name, { mem: {}, noticing: false, taking: false, since: 0 }]))
  const disabled = new Set()
  const failures = new Set()
  let takeovers = []

  function evaluate (bot, period) {
    let chosen = null
    for (const rule of rules) {
      const s = state.get(rule.name)
      let out = null
      try {
        out = rule.check(bot, s.mem, { period, taking: s.taking, events }) ?? null
      } catch (error) {
        if (!failures.has(rule.name)) {
          failures.add(rule.name)
          record('rules', { type: 'rule-error', rule: rule.name, error: String(error?.stack ?? error) })
          notify(`规则 ${rule.name} 抛错，已跳过：${error?.message ?? error}`)
        }
        continue
      }
      if (out?.notice) {
        if (!s.noticing) {
          s.noticing = true
          record('rules', { type: 'notice', rule: rule.name, period, text: out.notice, ...where(bot) })
          notify(`[${rule.name}] ${out.notice}`, { rule: rule.name, period, ...where(bot) })
        }
      } else {
        s.noticing = false
      }
      const wants = out?.inputs && period !== 'plugin' && !disabled.has(rule.name)
      const takes = Boolean(wants && !chosen)
      if (takes) chosen = { rule: rule.name, inputs: out.inputs }
      if (takes && !s.taking) {
        s.since = Date.now()
        s.period = period
        record('rules', { type: 'takeover-start', rule: rule.name, period, ...where(bot) })
      } else if (!takes && s.taking) {
        const ms = Date.now() - s.since
        if (s.period !== 'idle') takeovers.push({ rule: rule.name, period: s.period, ms })
        record('rules', { type: 'takeover-end', rule: rule.name, period, ms, ...where(bot) })
      }
      s.taking = takes
    }
    return chosen
  }

  return {
    evaluate,
    names: () => [...names],
    disable (name) {
      if (!names.has(name)) throw new Error(`no rule named ${name}; rules: ${[...names].join(', ')}`)
      disabled.add(name)
    },
    enable (name) { disabled.delete(name) },
    disabled: () => [...disabled],
    /** Called at task end: restore disabled rules, return takeovers since the last call. */
    endTask () {
      for (const [rule, s] of state) {
        if (!s.taking || s.period === 'idle') continue
        takeovers.push({ rule, period: 'steps', ms: Date.now() - s.since, ongoing: true })
        s.since = Date.now()
      }
      const list = takeovers
      takeovers = []
      const wasDisabled = [...disabled]
      disabled.clear()
      return { takeovers: list, disabled: wasDisabled }
    },
    takingRule () {
      for (const [name, s] of state) if (s.taking) return name
      return null
    }
  }
}

function where (bot) {
  const p = bot.entity?.position
  return p ? { pos: [round(p.x), round(p.y), round(p.z)] } : {}
}

function round (n) {
  return Math.round(n * 10) / 10
}

/** "low-air ×2 共 6.1 秒" style summary of takeovers. */
export function summarizeTakeovers (takeovers) {
  const byRule = new Map()
  for (const t of takeovers) {
    const entry = byRule.get(t.rule) ?? { count: 0, ms: 0 }
    entry.count += 1
    entry.ms += t.ms
    byRule.set(t.rule, entry)
  }
  return [...byRule].map(([rule, { count, ms }]) => `${rule} ×${count} 共 ${(ms / 1000).toFixed(1)} 秒`)
}
