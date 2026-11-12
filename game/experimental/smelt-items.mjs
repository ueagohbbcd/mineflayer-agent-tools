// SPDX-License-Identifier: MIT
// Experimental (see README): smelt items in a furnace within reach, placing
// one from the inventory (placeNear) when there is none, and take the output.
//
//   const r = await smeltItems(bot, ctx, 'raw_iron', 8)            fuel: the best in the inventory
//   const r = await smeltItems(bot, ctx, 'raw_iron', 8, 'oak_planks')
//   node game.mjs run <toolkit>/game/experimental/smelt-items.mjs raw_iron 8 [fuel]
import { setTimeout as sleep } from 'node:timers/promises'
import { placeNear } from './place-near.mjs'

// Items smelted per fuel item, best first (the fuel picked when none is named).
const FUEL = { coal_block: 80, coal: 8, charcoal: 8, blaze_rod: 12, oak_log: 1.5, spruce_log: 1.5, birch_log: 1.5, jungle_log: 1.5, acacia_log: 1.5, dark_oak_log: 1.5, mangrove_log: 1.5, cherry_log: 1.5, oak_planks: 1.5, spruce_planks: 1.5, birch_planks: 1.5, jungle_planks: 1.5, acacia_planks: 1.5, dark_oak_planks: 1.5, mangrove_planks: 1.5, cherry_planks: 1.5, bamboo_planks: 1.5, stick: 0.5 }
const ITEM_MS = 10000 // one item in a furnace
const CHECK_MS = 10000

// Does: finds a furnace within reach or places one; on the first visit takes
//   out what is in the output, gives back an input of another kind, counts an
//   input of the same kind towards `count`, puts in the rest (as much as the
//   inventory has) and enough fuel when the fuel slot is empty; then every
//   10 s opens the furnace, takes the output and closes it again, until the
//   input is used up. Returns { input, smelting, took, furnace }. Throws when
//   there is no input, no fuel or no furnace.
// Checked: 2026-11-12, local 1.21.1: a plain furnace (1 run); a furnace left
//   with glass in the output, with sand in the input, with 3 of the same input
//   after a cancel (1 run each); none near, placed one (1 run). Cancel during
//   the wait ends it within 0.1 s.
// Limits: waits 10 s per item plus 20 s at most; leaves a fuel slot with
//   another fuel alone (it may run out); the window stays closed between checks
//   so eating and fighting can use the hand.
export async function smeltItems (bot, ctx, input, count, fuel = null) {
  ctx.signal.throwIfAborted()
  const eyes = bot.entity.position.offset(0, 1.62, 0)
  const block = bot.findBlock({ matching: bot.registry.blocksByName.furnace.id, maxDistance: 5, useExtraInfo: b => b.position.offset(0.5, 0.5, 0.5).distanceTo(eyes) <= 4.5 }) ??
    await placeNear(bot, ctx, 'furnace')

  let window = null
  // cleanup: an open furnace window is closed on every exit, cancel included
  ctx.cleanup(() => window?.close())
  const open = async () => {
    window = await bot.openFurnace(block)
    ctx.signal.throwIfAborted() // exit rule: our own await, so check the signal
    return window
  }
  const close = () => { window?.close(); window = null }
  const took = {}
  const takeOutput = async () => {
    const out = window.outputItem()
    if (!out) return
    await window.takeOutput()
    ctx.signal.throwIfAborted()
    took[out.name] = (took[out.name] ?? 0) + out.count
  }

  // First visit: clear what is in the way, then fill.
  await open()
  await takeOutput()
  const inId = bot.registry.itemsByName[input]?.id
  if (inId === undefined) throw new Error(`no item named ${input}`)
  let already = 0
  const inSlot = window.inputItem()
  if (inSlot && inSlot.type !== inId) {
    ctx.log(`the furnace held ${inSlot.count} ${inSlot.name}; taking it out`)
    await window.takeInput()
    ctx.signal.throwIfAborted()
  } else if (inSlot) {
    already = inSlot.count
  }
  const have = bot.inventory.count(inId, null)
  const put = Math.min(have, Math.max(0, count - already))
  const smelting = already + put
  if (!smelting) throw new Error(`no ${input} in the inventory or the furnace`)
  if (!window.fuelItem()) {
    const fuelName = fuel ?? Object.keys(FUEL).find(n => bot.inventory.items().some(i => i.name === n))
    const fuelId = bot.registry.itemsByName[fuelName ?? '']?.id
    const fuelHave = fuelId === undefined ? 0 : bot.inventory.count(fuelId, null)
    if (!fuelHave) throw new Error(`no fuel in the inventory${fuel ? ` (${fuel})` : ''}: coal, charcoal, logs or planks`)
    await window.putFuel(fuelId, null, Math.min(fuelHave, Math.ceil(smelting / (FUEL[fuelName] ?? 1))))
    ctx.signal.throwIfAborted()
  }
  // Put only what the inventory has: asking for more moved the items, then threw (playtest 2026-11-10).
  if (put) await window.putInput(inId, null, put)
  ctx.signal.throwIfAborted()
  close()
  ctx.log(`smelting ${smelting} ${input} at ${block.position}${already ? ` (${already} were already in)` : ''}`)

  const deadline = Date.now() + smelting * ITEM_MS + 20000
  for (;;) {
    // A wait longer than the 5 s exit grace must end on the signal itself
    // (a plain 10 s timer left this routine stuck on cancel); it throws then.
    await sleep(CHECK_MS, null, { signal: ctx.signal })
    await open()
    await takeOutput()
    const left = window.inputItem()?.count ?? 0
    close()
    ctx.log(`took so far: ${Object.entries(took).map(([n, c]) => `${n} ${c}`).join(', ') || 'nothing'}; ${left} ${input} left`)
    if (!left) break // the input count drops as each item finishes, so 0 means all done
    if (Date.now() > deadline) throw new Error(`${left} ${input} still in the furnace at ${block.position} after ${Math.round(smelting * ITEM_MS / 1000) + 20} s; out of fuel? Add fuel and run again`)
  }
  return { input, smelting, took, furnace: [block.position.x, block.position.y, block.position.z] }
}

// As a job: run smelt-items.mjs INPUT COUNT [FUEL]
export default async function task (bot, ctx) {
  const [input, count, fuel] = ctx.args
  if (!input || !count) throw new Error('usage: run smelt-items.mjs INPUT COUNT [FUEL]')
  return smeltItems(bot, ctx, input, Number(count), fuel)
}
