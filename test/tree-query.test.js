'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const { queryTreeCandidate } = require('../lib/tree-query')

const origin = { x: 0, y: 0, z: 0 }
const id = p => `${p.x},${p.y},${p.z}`
const codes = result => result.uncertainty.map(item => item.code)

function world (blocks = [], unavailable = new Map()) {
  const cells = new Map(blocks.map(block => [id(block), block]))
  const calls = []
  return {
    cells,
    calls,
    blockAt (p) {
      assert.ok(p instanceof Vec3, 'native Mineflayer blockAt must receive Vec3')
      assert.deepEqual(p.floored(), p)
      calls.push(id(p))
      if (unavailable.has(id(p))) return unavailable.get(id(p))
      return cells.get(id(p)) || { name: 'air' }
    }
  }
}

function tree (name, height, width = 1) {
  const logs = []
  for (let y = 0; y < height; y++) {
    for (let z = 0; z < width; z++) {
      for (let x = 0; x < width; x++) logs.push({ x, y, z, name: `${name}_log` })
    }
  }
  return [...logs, { x: 0, y: height, z: 0, name: `${name}_leaves`, properties: { persistent: false } }]
}

test('on-demand query reports bounded oak, birch and large spruce log candidates', () => {
  for (const [species, height, width] of [['oak', 5, 1], ['birch', 7, 1], ['spruce', 16, 2]]) {
    const blocks = tree(species, height, width), source = world(blocks)
    assert.equal(source.calls.length, 0, 'construction does not scan')
    const result = queryTreeCandidate({ blockAt: source.blockAt, seed: origin })
    assert.equal(result.status, 'candidate')
    assert.equal(result.connectivity, 26)
    assert.equal(result.logs.length, height * width * width)
    assert.deepEqual(new Set(result.logs.map(id)), new Set(blocks.filter(b => b.name.endsWith('_log')).map(id)))
    assert.equal(result.leafEvidence.count, 1)
    assert.equal(result.leafEvidence.nonPersistentCount, 1)
    assert.equal(result.leafEvidence.complete, true)
    assert.equal(result.logTraversalComplete, true)
    assert.equal(result.truncated, false)
    assert.deepEqual(result.unknownBoundaries, [])
    assert.ok(codes(result).includes('artificial_structure_possible'))
    assert.ok(codes(result).includes('adjacent_trees_may_merge'))
    assert.equal(source.calls.length, new Set(source.calls).size, 'one read per distinct voxel')
    assert.equal(result.stats.blockReads, source.calls.length)
    assert.ok(result.stats.knownAirReads > 0)
  }
})

test('default 26-neighbor connectivity preserves diagonal acacia branches; 6 is explicit', () => {
  const blocks = [
    { x: 0, y: 0, z: 0, name: 'acacia_log' },
    { x: 0, y: 1, z: 0, name: 'acacia_log' },
    { x: 1, y: 2, z: 0, name: 'acacia_log' },
    { x: 2, y: 3, z: 1, name: 'acacia_log' },
    { x: 2, y: 4, z: 1, name: 'acacia_leaves' }
  ]
  const source = world(blocks)
  const diagonal = queryTreeCandidate({ blockAt: source.blockAt, seed: origin })
  assert.equal(diagonal.logs.length, 4)
  const faces = queryTreeCandidate({ blockAt: source.blockAt, seed: origin, connectivity: 6 })
  assert.equal(faces.logs.length, 2)
  assert.equal(faces.connectivity, 6)
  assert.ok(codes(faces).includes('diagonal_logs_may_be_missed'))
})

test('connected log buildings remain uncertain candidates even without leaves', () => {
  const blocks = Array.from({ length: 8 }, (_, x) => ({ x, y: 0, z: 0, name: 'oak_log' }))
  const result = queryTreeCandidate({ blockAt: world(blocks).blockAt, seed: origin })
  assert.equal(result.status, 'candidate')
  assert.equal(result.logs.length, 8)
  assert.equal(result.leafEvidence.count, 0)
  assert.ok(codes(result).includes('no_leaf_evidence'))
  assert.ok(codes(result).includes('artificial_structure_possible'))
})

test('adjacent mixed trees may merge and exact-name traversal can exclude other logs', () => {
  const source = world([
    { ...origin, name: 'minecraft:oak_log' },
    { x: 1, y: 1, z: 1, name: 'birch_log' },
    { x: 2, y: 2, z: 2, name: 'birch_leaves' }
  ])
  const mixed = queryTreeCandidate({ blockAt: source.blockAt, seed: origin })
  assert.deepEqual(mixed.logs.map(b => b.name), ['oak_log', 'birch_log'])
  assert.ok(codes(mixed).includes('mixed_log_types'))
  assert.ok(codes(mixed).includes('adjacent_trees_may_merge'))
  const same = queryTreeCandidate({ blockAt: source.blockAt, seed: origin, includeMixedLogs: false })
  assert.equal(same.logs.length, 1)
  assert.equal(same.includeMixedLogs, false)
})

test('null and known:false boundaries never become known air or candidate logs', () => {
  const unavailable = new Map([
    ['1,0,0', null],
    ['-1,0,0', { name: 'oak_log', known: false }],
    ['0,0,1', { name: 'air', known: false }],
    ['0,0,-1', { known: true }]
  ])
  const source = world([{ ...origin, name: 'oak_log' }], unavailable)
  const result = queryTreeCandidate({ blockAt: source.blockAt, seed: origin })
  assert.equal(result.logs.length, 1)
  assert.equal(result.stats.unknownReads, 4)
  assert.equal(result.unknownBoundaries.length, 4)
  assert.deepEqual(new Set(result.unknownBoundaries.map(id)), new Set(unavailable.keys()))
  assert.ok(result.unknownBoundaries.every(p => p.phases.includes('logs') && p.phases.includes('leaves')))
  assert.equal(result.logTraversalComplete, false)
  assert.equal(result.leafEvidence.complete, false)
  assert.equal(result.truncated, false, 'unknown space differs from a query budget limit')
  assert.ok(codes(result).includes('unknown_boundary'))
  assert.ok(codes(result).includes('leaf_evidence_incomplete'))
  assert.ok(!codes(result).includes('no_leaf_evidence'))
  assert.equal(result.stats.knownAirReads, result.stats.blockReads - 5)
})

test('unknown seeds and known non-log seeds stop after one synchronous read', () => {
  for (const missing of [null, undefined, { known: false, name: 'air' }]) {
    let calls = 0
    const result = queryTreeCandidate({ blockAt: () => { calls++; return missing }, seed: origin })
    assert.equal(result.status, 'unknown_seed')
    assert.equal(result.unknownBoundaries.length, 1)
    assert.equal(result.logTraversalComplete, false)
    assert.equal(result.logs.length, 0)
    assert.equal(calls, 1)
  }
  for (const name of ['air', 'cave_air', 'void_air', 'stone', 'oak_planks', 'oak_wood', 'crimson_stem']) {
    const result = queryTreeCandidate({ blockAt: () => ({ name }), seed: origin })
    assert.equal(result.status, 'not_a_log')
    assert.equal(result.stats.blockReads, 1)
    assert.equal(result.logs.length, 0)
    assert.deepEqual(result.unknownBoundaries, [])
    assert.equal(result.stats.knownAirReads, name.endsWith('air') ? 1 : 0)
  }
})

test('budgets limit actual block reads and log output, not merely metadata', () => {
  const logWorld = world(tree('oak', 20))
  const capped = queryTreeCandidate({ blockAt: logWorld.blockAt, seed: origin, maxLogs: 3 })
  assert.equal(capped.logs.length, 3)
  assert.ok(capped.truncationReasons.includes('maxLogs'))
  assert.equal(capped.logTraversalComplete, false)
  assert.equal(capped.truncated, true)

  const reads = world(tree('oak', 20))
  const budget = queryTreeCandidate({ blockAt: reads.blockAt, seed: origin, maxReads: 7 })
  assert.equal(reads.calls.length, 7)
  assert.equal(budget.stats.blockReads, 7)
  assert.ok(budget.truncationReasons.includes('maxReads'))
  assert.equal(budget.logTraversalComplete, false)
  assert.equal(budget.leafEvidence.complete, false)
  assert.ok(codes(budget).includes('bounded_query'))

  const exact = queryTreeCandidate({ blockAt: world([{ ...origin, name: 'oak_log' }]).blockAt, seed: origin, maxLogs: 1 })
  assert.equal(exact.truncated, false, 'reaching a cap alone does not prove an omitted log')
})

test('range is an inclusive Chebyshev cube and out-of-range cells are never read', () => {
  const source = world(tree('spruce', 10))
  const result = queryTreeCandidate({ blockAt: source.blockAt, seed: origin, maxDistance: 2 })
  assert.equal(result.logs.length, 3)
  assert.ok(result.truncationReasons.includes('maxDistance'))
  assert.equal(result.logTraversalComplete, false)
  assert.ok(source.calls.every(value => value.split(',').every(n => Math.abs(Number(n)) <= 2)))
  const seedOnly = queryTreeCandidate({ blockAt: source.blockAt, seed: origin, maxDistance: 0 })
  assert.equal(seedOnly.stats.blockReads, 1)
  assert.equal(seedOnly.logs.length, 1)
  assert.ok(seedOnly.truncationReasons.includes('maxDistance'))
})

test('leaf scanning has its own completeness and preserves uncertain provenance', () => {
  const source = world([
    { ...origin, name: 'stripped_oak_log' },
    { x: 1, y: 0, z: 0, name: 'oak_leaves', getProperties: () => ({ persistent: 'true' }) },
    { x: 2, y: 0, z: 0, name: 'birch_leaves', properties: { persistent: 'false' } },
    { x: 0, y: 1, z: 0, name: 'azalea_leaves' }
  ])
  const result = queryTreeCandidate({ blockAt: source.blockAt, seed: origin })
  assert.equal(result.leafEvidence.count, 3)
  assert.equal(result.leafEvidence.persistentCount, 1)
  assert.equal(result.leafEvidence.nonPersistentCount, 1)
  assert.equal(result.leafEvidence.unknownPersistenceCount, 1)
  assert.ok(codes(result).includes('persistent_leaves_present'))
  assert.ok(codes(result).includes('stripped_logs_present'))
  const clipped = queryTreeCandidate({ blockAt: source.blockAt, seed: origin, maxDistance: 1 })
  assert.equal(clipped.logTraversalComplete, true)
  assert.equal(clipped.leafEvidence.complete, false)
  assert.ok(clipped.truncationReasons.includes('maxDistance'))
  const disabled = queryTreeCandidate({ blockAt: source.blockAt, seed: origin, leafRadius: 0 })
  assert.equal(disabled.leafEvidence.enabled, false)
  assert.equal(disabled.leafEvidence.count, 0)
  assert.equal(disabled.leafEvidence.complete, false)
  assert.ok(codes(disabled).includes('leaf_evidence_disabled'))
  assert.equal(disabled.stats.blockReads, 27)
})

test('native Prismarine chunk blocks, Vec3 and negative coordinates are compatible', () => {
  const registry = require('prismarine-registry')('1.21.1')
  const Chunk = require('prismarine-chunk')('1.21.1')
  const chunk = new Chunk({ minY: -16, worldHeight: 32 })
  chunk.setBlockStateId(new Vec3(15, -2, 15), registry.blocksByName.oak_log.defaultState)
  chunk.setBlockStateId(new Vec3(15, -1, 15), registry.blocksByName.oak_leaves.defaultState)
  const result = queryTreeCandidate({
    seed: new Vec3(-1, -2, -1),
    blockAt (p) {
      assert.equal(typeof p.floored, 'function')
      if (Math.floor(p.x / 16) !== -1 || Math.floor(p.z / 16) !== -1 || p.y < -16 || p.y >= 16) return null
      return chunk.getBlock(new Vec3(p.x & 15, p.y, p.z & 15))
    }
  })
  assert.deepEqual(result.logs, [{ x: -1, y: -2, z: -1, name: 'oak_log' }])
  assert.equal(result.leafEvidence.count, 1)
  assert.ok(result.unknownBoundaries.length > 0)
  assert.doesNotThrow(() => JSON.stringify(result))
})

test('invalid options fail before any world reads and asynchronous readers are rejected', () => {
  let calls = 0
  const valid = { blockAt: () => { calls++; return { name: 'air' } }, seed: origin }
  for (const key of ['maxLogs', 'maxDistance', 'maxReads', 'leafRadius']) {
    for (const value of [NaN, Infinity, 1.5, '4', null, Number.MAX_SAFE_INTEGER + 1, -1]) {
      assert.throws(() => queryTreeCandidate({ ...valid, [key]: value }), { name: value === -1 ? 'RangeError' : 'TypeError' })
    }
  }
  for (const options of [{ maxLogs: 0 }, { maxReads: 0 }, { connectivity: 18 }, { connectivity: '26' }]) {
    assert.throws(() => queryTreeCandidate({ ...valid, ...options }), RangeError)
  }
  for (const options of [{ blockAt: null }, { seed: null }, { seed: { ...origin, y: 0.5 } }, { seed: { x: 0, y: 0 } }, { includeMixedLogs: 1 }]) {
    assert.throws(() => queryTreeCandidate({ ...valid, ...options }), TypeError)
  }
  assert.throws(() => queryTreeCandidate({ ...valid, seed: { ...origin, x: Infinity } }), TypeError)
  for (const options of [undefined, null, [], true]) assert.throws(() => queryTreeCandidate(options), TypeError)
  assert.equal(calls, 0)
  assert.throws(() => queryTreeCandidate({ ...valid, blockAt: async () => ({ name: 'oak_log' }) }), /synchronously/)
})

test('caller budgets have no arbitrary caps and large leaf neighborhoods are lazy', () => {
  const source = world([{ ...origin, name: 'oak_log' }])
  const larger = queryTreeCandidate({ blockAt: source.blockAt, seed: origin, maxLogs: 4097, maxReads: 262145, maxDistance: 129, leafRadius: 5 })
  assert.equal(larger.logs.length, 1)
  assert.equal(larger.stats.blockReads, 11 ** 3)
  assert.equal(larger.truncated, false)

  const clipped = queryTreeCandidate({ blockAt: source.blockAt, seed: origin, maxDistance: 2, leafRadius: 1_000_000_000 })
  assert.equal(clipped.stats.blockReads, 5 ** 3)
  assert.ok(clipped.truncationReasons.includes('maxDistance'))

  const limited = queryTreeCandidate({ blockAt: source.blockAt, seed: origin, maxDistance: 1_000_000_000, leafRadius: 1_000_000_000, maxReads: 7 })
  assert.equal(limited.stats.blockReads, 7)
  assert.ok(limited.truncationReasons.includes('maxReads'))

  const edge = queryTreeCandidate({ blockAt: () => ({ name: 'air' }), seed: { ...origin, x: Number.MAX_SAFE_INTEGER } })
  assert.equal(edge.status, 'not_a_log', 'basic seed validation does not impose a seed-plus-margin rule')
})

test('query results do not mutate or expose the caller\'s native block objects', () => {
  const seed = Object.freeze({ ...origin })
  const block = Object.freeze({ name: 'oak_log', position: Object.freeze(new Vec3(900, 900, 900)) })
  const result = queryTreeCandidate({ seed, blockAt: p => id(p) === '0,0,0' ? block : { name: 'air' } })
  result.logs[0].x = 100
  result.seed.x = 200
  assert.equal(seed.x, 0)
  assert.equal(block.position.x, 900)
})
