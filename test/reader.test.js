const test = require('node:test')
const assert = require('node:assert/strict')
const { readWorldBlock } = require('../reader')
const position = { x: 17, y: 64, z: -1 }
const bot = (loaded = false) => ({
  game: { dimension: 'overworld' },
  world: { getColumn: () => loaded ? {} : null },
  blockAt: () => null
})

test('live block always wins over historical chunks', () => {
  const b = bot()
  b.blockAt = () => ({ name: 'fresh' })
  assert.equal(readWorldBlock(b, position, {
    chunkInfo () { throw Error('history should not be used') }
  }).source, 'live')
})

test('history can be disabled, with no behavior change to live queries', () => {
  assert.deepEqual(readWorldBlock(bot(), position), {
    block: null, source: 'unknown', loaded: false, observedAt: null
  })
})

test('only unloaded historical chunks can provide fallback', () => {
  const memory = {
    chunkInfo: ({ x, z }) => { assert.equal(x, 1); assert.equal(z, -1); return { loaded: false, observedAt: 1234 } },
    block: () => ({ name: 'old_stone' })
  }
  const result = readWorldBlock(bot(), position, memory)
  assert.equal(result.source, 'historical')
  assert.equal(result.block.name, 'old_stone')
  assert.equal(result.observedAt, 1234)
})

test('loaded but unknown cells never fall back to history', () => {
  const result = readWorldBlock(bot(true), position, {
    chunkInfo () { throw Error('stale history should not be read') }
  })
  assert.equal(result.source, 'unknown')
  assert.equal(result.loaded, true)
})

test('remembered but loaded record is not an unloaded fallback', () => {
  const result = readWorldBlock(bot(), position, {
    chunkInfo: () => ({ loaded: true }),
    block: () => { throw Error('do not use loaded record') }
  })
  assert.equal(result.source, 'unknown')
})

test('other dimensions bypass the live world', () => {
  const b = bot(true)
  b.blockAt = () => { throw Error('not the requested dimension') }
  const result = readWorldBlock(b, { ...position, dimension: 'the_nether' }, {
    chunkInfo: () => ({ loaded: false, observedAt: 99 }),
    block: () => ({ name: 'netherrack' })
  })
  assert.equal(result.source, 'historical')
})
