const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { mkdtemp, rm } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const path = require('node:path')
const { createWorldMemory } = require('..')
const registry = require('prismarine-registry')('1.21.1')
const Chunk = require('prismarine-chunk')(registry)
function fixture (columns = new Map()) {
  const bot = new EventEmitter()
  Object.assign(bot, { version: '1.21.1', registry, game: { dimension: 'overworld', minY: -64, height: 384 }, world: {
    getColumn: (x, z) => columns.get(`${x},${z}`),
    getColumns: () => [...columns].map(([key, column]) => { const [chunkX, chunkZ] = key.split(',').map(Number); return { chunkX, chunkZ, column } })
  } })
  return bot
}
const turn = () => new Promise(resolve => setImmediate(resolve))
test('lazy native memory records sealed blocks, updates, unloads, replacements and dimensions without analysis', async () => {
  const chunk = new Chunk({ minY: -64, worldHeight: 384 }), p = { x: 15, y: -40, z: 3 }
  chunk.setBlockStateId(p, registry.blocksByName.diamond_ore.defaultState)
  let analysisReads = 0
  const original = chunk.getBlockStateId.bind(chunk)
  chunk.getBlockStateId = p => { analysisReads++; return original(p) }
  const columns = new Map([['-1,0', chunk]]), bot = fixture(columns)
  let now = 10
  const memory = createWorldMemory(bot, { analysis: 'lazy', now: () => now })
  await memory.ready; await turn()
  assert.equal(analysisReads, 0, 'capture/persistence scheduling never scans the column')
  assert.equal(memory.summary().pending, true, 'analysis is explicitly pending until requested')
  const world = { x: -1, y: -40, z: 3, dimension: 'overworld' }
  assert.equal(memory.block(world).name, 'diamond_ore')
  now = 20
  chunk.setBlockStateId(p, registry.blocksByName.dirt.defaultState)
  bot.emit('blockUpdate', {}, { position: world, stateId: registry.blocksByName.dirt.defaultState })
  columns.delete('-1,0'); bot.emit('chunkColumnUnload', { x: -16, z: 0 })
  assert.equal(memory.block(world).name, 'dirt')
  assert.equal(memory.chunkInfo({ x: -1, z: 0 }).loaded, false)
  assert.equal(memory.chunkInfo({ x: -1, z: 0 }).observedAt, 20)
  assert.equal(memory.block({ x: 999, y: 0, z: 999 }), null)
  const replacement = new Chunk({ minY: -64, worldHeight: 384 })
  now = 30; columns.set('-1,0', replacement); bot.emit('chunkColumnLoad', { x: -16, z: 0 })
  assert.equal(memory.block(world).name, 'air')
  assert.equal(memory.chunkInfo({ x: -1, z: 0 }).loaded, true)
  bot.game.dimension = 'the_nether'; columns.clear(); bot.emit('spawn')
  assert.equal(memory.chunkInfo({ x: -1, z: 0, dimension: 'overworld' }).loaded, false)
  assert.equal(memory.block({ ...world, dimension: 'the_nether' }), null)
  assert.equal(memory.chunks().length, 1)
  assert.deepEqual(memory.chunks({ dimension: 'the_nether' }), [])
  const list = memory.chunks(); list[0].loaded = true
  assert.equal(memory.chunks()[0].loaded, false, 'metadata snapshots are detached')
  await memory.dispose()
})
test('lazy close persists and restores full native data without computing exposure', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'lazy-memory-'))
  try {
    const chunk = new Chunk({ minY: -64, worldHeight: 384 }), p = { x: 2, y: -60, z: 4 }
    chunk.setBlockStateId(p, registry.blocksByName.gold_ore.defaultState)
    const bot = fixture(new Map([['0,0', chunk]]))
    bot.registry = { get blocksByStateId () { throw new Error('unexpected exposure analysis') } }
    const memory = createWorldMemory(bot, { analysis: 'lazy', directory, worldId: 'run:a:role:b' })
    await memory.ready; await memory.flush(); await memory.dispose()
    const restored = createWorldMemory(fixture(), { analysis: 'lazy', directory, worldId: 'run:a:role:b' })
    await restored.ready
    assert.equal(restored.block(p).name, 'gold_ore')
    assert.equal(restored.chunks()[0].loaded, false)
    const isolated = createWorldMemory(fixture(), { analysis: 'lazy', directory, worldId: 'run:c:role:b' })
    await isolated.ready; assert.equal(isolated.block(p), null)
    await restored.dispose(); await isolated.dispose()
  } finally { await rm(directory, { recursive: true, force: true }) }
})
test('lazy exposure queries remain available on demand', async () => {
  const chunk = new Chunk({ minY: 0, worldHeight: 16 })
  chunk.setBlockStateId({ x: 3, y: 10, z: 3 }, registry.blocksByName.dirt.defaultState)
  const memory = createWorldMemory(fixture(new Map([['0,0', chunk]])), { analysis: 'lazy' })
  const result = await memory.find({ name: 'dirt' })
  assert.equal(result.total, 1)
  assert.equal(memory.summary().pending, false)
  await memory.dispose()
})
