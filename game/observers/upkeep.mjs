// SPDX-License-Identifier: MIT
// Report function for what wears out and what acted on its own: a tool that
// broke, the held tool nearly broken, food low with nothing to eat, and what
// was eaten, fought and fled from since the last report (by idle, a reflex or
// a task). Players asked for each of these after the 2026-11-10 playtest.
//
//   host.addReport('upkeep', upkeepReport(bot))     after loadPlugins
//
// Sources: inventory slot updates (a tool slot emptied at its last uses),
// mineflayer-auto-eat 'eatFinish', mineflayer-pvp 'startedAttacking', and the
// 'flee' event fightOrFlee emits on the bot.

export function upkeepReport (bot) {
  // Since the last report; emptied by each call.
  let broke = []
  let ate = {}
  let fought = {}
  let fled = 0
  const add = (map, name) => { map[name] = (map[name] ?? 0) + 1 }

  bot.inventory.on('updateSlot', (slot, old, now) => {
    // A move empties a slot too; a slot emptied with 2 uses or fewer left is a break.
    if (old?.maxDurability && !now && old.maxDurability - (old.durabilityUsed ?? 0) <= 2) broke.push(old.name)
  })
  bot.autoEat?.on('eatFinish', opts => add(ate, opts?.food?.name ?? 'something'))
  bot.on('startedAttacking', () => add(fought, bot.pvp?.target?.name ?? 'something'))
  bot.on('flee', () => fled++)

  return () => {
    const lines = []
    if (broke.length) lines.push(`broke: ${broke.join(', ')}; craft another before going on`)
    const held = bot.heldItem
    if (held?.maxDurability) {
      const left = held.maxDurability - (held.durabilityUsed ?? 0)
      if (left <= Math.max(5, held.maxDurability / 10)) lines.push(`held ${held.name} has ${left} of ${held.maxDurability} uses left`)
    }
    if (bot.food <= 10 && !bot.inventory.items().some(i => bot.registry.foodsByName[i.name])) {
      lines.push(`food ${bot.food}/20 and nothing to eat in the inventory; health stops coming back below 18`)
    }
    const acts = [
      ...Object.entries(ate).map(([n, c]) => `ate ${n}${c > 1 ? ` ×${c}` : ''}`),
      ...Object.entries(fought).map(([n, c]) => `fought ${n}${c > 1 ? ` ×${c}` : ''}`),
      ...(fled ? [`fled ${fled === 1 ? 'once' : `${fled} times`}`] : [])
    ]
    if (acts.length) lines.push(`since the last report: ${acts.join(', ')}`)
    broke = []
    ate = {}
    fought = {}
    fled = 0
    return lines.join('\n')
  }
}
