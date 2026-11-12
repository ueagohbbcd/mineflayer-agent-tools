// SPDX-License-Identifier: MIT
// Experimental (see README): place a block from the inventory (a crafting
// table, a furnace, anything) next to the bot, and note where in notes/places.md.
//
//   const table = await placeNear(bot, ctx, 'crafting_table')   → the placed Block
//   node game.mjs run <toolkit>/game/experimental/place-near.mjs furnace
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import vec3 from 'vec3'

// Blocks that open a window or toggle when clicked: never a placement face
// (placing against a furnace opened it, "the block is still air", playtest 2026-11-10).
const INTERACTABLE = new Set(createRequire(import.meta.url)('mineflayer-pathfinder/lib/interactable.json'))
// Cells a placed block may take: empty, or replaced by it (grass, water).
const FREE = ['air', 'cave_air', 'void_air', 'water', 'short_grass', 'tall_grass', 'fern', 'large_fern', 'dead_bush', 'snow']
const REACH = 4.5

// Does: places `itemName` from the inventory on top of a full solid block
//   within reach (1-3 blocks away, from a level below the feet to one above),
//   in a free cell the bot's body does not touch, never against a block that
//   opens a window; with no such cell (a 1-wide pit or tunnel) it digs a wall
//   cell at feet level first. Appends "<item> at x y z" to notes/places.md.
//   Returns the placed Block; throws when the item is missing or no cell fits.
// Checked: 2026-11-12, local 1.21.1: open ground (1 run); the bottom of a
//   1-wide shaft 3 and 5 deep, by digging a wall cell (2 runs); through
//   smeltItems and craftAndCount (1 run each); each wrote its notes line.
// Limits: places only on a top face; skips ore when digging a wall cell; the
//   note goes to notes/ under main's working directory (the project).
export async function placeNear (bot, ctx, itemName) {
  ctx.signal.throwIfAborted()
  const item = bot.inventory.items().find(i => i.name === itemName)
  if (!item) throw new Error(`no ${itemName} in the inventory`)
  let cell = freeCells(bot)[0]
  if (!cell) {
    const wall = wallCell(bot)
    if (!wall) throw new Error(`no free cell for ${itemName} near ${bot.entity.position.floored()} and no wall cell to dig out; move to open ground`)
    ctx.log(`no free cell; digging ${wall.name} at ${wall.position} to make room`)
    await bot.tool.equipForBlock(wall, {})
    ctx.signal.throwIfAborted() // exit rule: our own await, so check the signal
    await bot.dig(wall)
    ctx.signal.throwIfAborted()
    cell = wall.position
  }
  await bot.equip(item, 'hand')
  ctx.signal.throwIfAborted()
  await bot.placeBlock(bot.blockAt(cell.offset(0, -1, 0)), new vec3.Vec3(0, 1, 0))
  ctx.signal.throwIfAborted()
  const placed = bot.blockAt(cell)
  if (placed?.name !== itemName) throw new Error(`placing ${itemName} at ${cell} left ${placed?.name}`)
  notePlace(`${itemName} at ${cell.x} ${cell.y} ${cell.z}`)
  ctx.log(`placed ${itemName} at ${cell.x} ${cell.y} ${cell.z}`)
  return placed
}

// Does: appends "- <UTC time> <text>" to notes/places.md in the project, the
//   notes the player page asks a player to keep.
// Checked: through placeNear, 2026-11-12 (5 runs).
// Limits: the project is taken to be main's working directory.
export function notePlace (text) {
  const file = path.join(process.cwd(), 'notes', 'places.md')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  if (!fs.existsSync(file)) fs.writeFileSync(file, '# Places\n\n')
  fs.appendFileSync(file, `- ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC: ${text} (fact, placed by a routine)\n`)
}

// Blocks nobody minds spending, in the order they are used.
const FILLER = ['cobblestone', 'cobbled_deepslate', 'dirt', 'netherrack', 'andesite', 'diorite', 'granite', 'tuff', 'stone', 'deepslate', 'sandstone', 'terracotta']

// Does: an inventory item to build with (cobblestone, dirt, andesite, …: FILLER), or null.
// Checked: through climbToSurface and sealIn (see there).
// Limits: other blocks, however many, are never spent.
export function fillerBlock (bot) {
  const items = bot.inventory.items()
  for (const name of FILLER) {
    const item = items.find(i => i.name === name)
    if (item) return item
  }
  return null
}

// Free cells within reach on a full solid, non-interactable block, nearest first.
function freeCells (bot) {
  const me = bot.entity.position
  const feet = me.floored()
  const eyes = me.offset(0, 1.62, 0)
  const out = []
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -3; dx <= 3; dx++) {
      for (let dz = -3; dz <= 3; dz++) {
        const p = feet.offset(dx, dy, dz)
        const below = bot.blockAt(p.offset(0, -1, 0))
        if (!FREE.includes(bot.blockAt(p)?.name) || below?.boundingBox !== 'block' || INTERACTABLE.has(below.name)) continue
        if (touchesBot(me, p) || p.offset(0.5, 0.5, 0.5).distanceTo(eyes) > REACH) continue
        out.push(p)
      }
    }
  }
  return out.sort((a, b) => a.distanceTo(feet) - b.distanceTo(feet))
}

// A diggable, non-ore wall block beside the feet, with a solid block below it.
function wallCell (bot) {
  const feet = bot.entity.position.floored()
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const b = bot.blockAt(feet.offset(dx, 0, dz))
    const below = bot.blockAt(feet.offset(dx, -1, dz))
    if (b?.boundingBox === 'block' && b.diggable && !b.name.endsWith('_ore') && !INTERACTABLE.has(b.name) && below?.boundingBox === 'block') return b
  }
  return null
}

// The player's box is 0.6 wide and 1.8 high around its feet position.
function touchesBot (me, p) {
  return p.x < me.x + 0.3 && p.x + 1 > me.x - 0.3 && p.z < me.z + 0.3 && p.z + 1 > me.z - 0.3 && p.y < me.y + 1.8 && p.y + 1 > me.y
}

// As a job: run place-near.mjs ITEM
export default async function task (bot, ctx) {
  if (!ctx.args[0]) throw new Error('usage: run place-near.mjs ITEM   (crafting_table, furnace, …)')
  const b = await placeNear(bot, ctx, ctx.args[0])
  return { placed: b.name, at: [b.position.x, b.position.y, b.position.z] }
}
