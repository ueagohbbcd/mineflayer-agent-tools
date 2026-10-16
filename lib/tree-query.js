// SPDX-License-Identifier: MIT
'use strict'

const { Vec3 } = require('vec3')

const AIR = new Set(['air', 'cave_air', 'void_air'])
const LOG = /^[a-z0-9_]+_log$/
const LEAVES = /^[a-z0-9_]+_leaves$/
const UNREAD = Symbol('unread')
const point = p => ({ x: p.x, y: p.y, z: p.z })
const key = p => `${p.x},${p.y},${p.z}`

function integerOption (name, value, min) {
  if (!Number.isSafeInteger(value)) throw new TypeError(`${name} must be a safe integer`)
  if (value < min) throw new RangeError(`${name} must be at least ${min}`)
  return value
}

function offsets (radius, connectivity) {
  const result = []
  for (let y = -radius; y <= radius; y++) {
    for (let z = -radius; z <= radius; z++) {
      for (let x = -radius; x <= radius; x++) {
        if (x === 0 && y === 0 && z === 0) continue
        if (connectivity === 6 && Math.abs(x) + Math.abs(y) + Math.abs(z) !== 1) continue
        result.push({ x, y, z })
      }
    }
  }
  return result
}

// Start nearby and intersect with the query cube before iterating. A very large
// caller-selected radius must not allocate an offsets array or walk an enormous
// out-of-range region before the read budget can stop it.
function * axisOffsets (min, max) {
  yield 0
  for (let distance = 1; distance <= Math.max(-min, max); distance++) {
    if (distance <= max) yield distance
    if (-distance >= min) yield -distance
  }
}

function * leafOffsets (log, seed, maxDistance, radius) {
  const range = axis => ({
    min: Math.max(-radius, seed[axis] - log[axis] - maxDistance),
    max: Math.min(radius, seed[axis] - log[axis] + maxDistance)
  })
  const xRange = range('x'), yRange = range('y'), zRange = range('z')
  for (const y of axisOffsets(yRange.min, yRange.max)) {
    for (const z of axisOffsets(zRange.min, zRange.max)) {
      for (const x of axisOffsets(xRange.min, xRange.max)) {
        if (x !== 0 || y !== 0 || z !== 0) yield { x, y, z }
      }
    }
  }
}

/**
 * Read a bounded connected log candidate on demand. No movement, world changes,
 * listener installation, background scan, or claim of a whole natural tree.
 * blockAt receives a native Vec3 and must synchronously return a block or null.
 */
function queryTreeCandidate (options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('queryTreeCandidate requires an options object')
  }
  const { blockAt, seed, connectivity = 26, includeMixedLogs = true } = options
  if (typeof blockAt !== 'function') throw new TypeError('blockAt must be a synchronous function')
  if (!seed || !['x', 'y', 'z'].every(axis => Number.isSafeInteger(seed[axis]))) {
    throw new TypeError('seed must have safe integer x, y, z block coordinates')
  }
  if (connectivity !== 6 && connectivity !== 26) throw new RangeError('connectivity must be 6 or 26')
  if (typeof includeMixedLogs !== 'boolean') throw new TypeError('includeMixedLogs must be boolean')
  const maxLogs = integerOption('maxLogs', options.maxLogs === undefined ? 256 : options.maxLogs, 1)
  const maxDistance = integerOption('maxDistance', options.maxDistance === undefined ? 24 : options.maxDistance, 0)
  const maxReads = integerOption('maxReads', options.maxReads === undefined ? 8192 : options.maxReads, 1)
  const leafRadius = integerOption('leafRadius', options.leafRadius === undefined ? 2 : options.leafRadius, 0)

  const origin = point(seed)
  const cache = new Map(), unknown = new Map(), leaves = new Map(), accepted = new Set()
  const reasons = new Set(), logs = []
  const complete = { logs: true, leaves: leafRadius > 0 }
  const stats = { blockReads: 0, knownAirReads: 0, unknownReads: 0 }
  const bounds = {
    min: { x: origin.x - maxDistance, y: origin.y - maxDistance, z: origin.z - maxDistance },
    max: { x: origin.x + maxDistance, y: origin.y + maxDistance, z: origin.z + maxDistance }
  }

  function read (p, phase) {
    if (['x', 'y', 'z'].some(axis => p[axis] < bounds.min[axis] || p[axis] > bounds.max[axis])) {
      reasons.add('maxDistance')
      complete[phase] = false
      return UNREAD
    }
    const id = key(p)
    if (!cache.has(id)) {
      if (stats.blockReads >= maxReads) {
        reasons.add('maxReads')
        complete[phase] = false
        return UNREAD
      }
      stats.blockReads++
      const block = blockAt(new Vec3(p.x, p.y, p.z))
      if (block && typeof block.then === 'function') {
        throw new TypeError('blockAt must return blocks synchronously, not a Promise')
      }
      const name = typeof block?.name === 'string' ? block.name.replace(/^minecraft:/, '') : ''
      const known = block != null && block.known !== false && name.length > 0
      const sample = known ? { ...point(p), name } : null
      if (sample && LEAVES.test(name)) {
        const properties = typeof block.getProperties === 'function' ? block.getProperties() : block.properties
        const persistent = properties?.persistent
        sample.persistent = persistent === true || persistent === 'true'
          ? true : persistent === false || persistent === 'false' ? false : null
      }
      cache.set(id, sample)
      if (!known) stats.unknownReads++
      else if (AIR.has(name)) stats.knownAirReads++
    }
    const sample = cache.get(id)
    if (sample === null) {
      complete[phase] = false
      if (!unknown.has(id)) unknown.set(id, { ...point(p), phases: new Set() })
      unknown.get(id).phases.add(phase)
    }
    return sample
  }

  function addLeaf (sample) {
    if (sample && sample !== UNREAD && LEAVES.test(sample.name)) leaves.set(key(sample), sample)
  }

  const start = read(origin, 'logs')
  const status = start === null ? 'unknown_seed' : LOG.test(start.name) ? 'candidate' : 'not_a_log'
  if (status === 'candidate') {
    logs.push(start)
    accepted.add(key(start))
    const neighbors = offsets(1, connectivity)
    traverse: for (let index = 0; index < logs.length; index++) {
      const current = logs[index]
      for (const delta of neighbors) {
        const p = { x: current.x + delta.x, y: current.y + delta.y, z: current.z + delta.z }
        if (accepted.has(key(p))) continue
        const sample = read(p, 'logs')
        // These probes are also leaf evidence within radius one of an accepted log.
        if (leafRadius > 0) addLeaf(sample)
        if (sample === UNREAD) {
          if (reasons.has('maxReads')) break traverse
          continue
        }
        if (!sample || !LOG.test(sample.name) || (!includeMixedLogs && sample.name !== start.name)) continue
        if (logs.length === maxLogs) {
          reasons.add('maxLogs')
          complete.logs = false
          continue
        }
        accepted.add(key(p))
        logs.push(sample)
      }
    }

    if (leafRadius > 0) {
      scanLeaves: for (const log of logs) {
        if (['x', 'y', 'z'].some(axis => leafRadius > maxDistance - Math.abs(log[axis] - origin[axis]))) {
          reasons.add('maxDistance')
          complete.leaves = false
        }
        for (const delta of leafOffsets(log, origin, maxDistance, leafRadius)) {
          const sample = read({ x: log.x + delta.x, y: log.y + delta.y, z: log.z + delta.z }, 'leaves')
          addLeaf(sample)
          if (sample === UNREAD && reasons.has('maxReads')) break scanLeaves
        }
      }
    }
  }

  const observedLeaves = [...leaves.values()]
  const uncertainty = []
  function warn (code, message) { uncertainty.push({ code, message }) }
  if (status === 'candidate') {
    warn('artificial_structure_possible', 'Connected logs, even beside leaves, may be player-built; natural origin and permission to remove them are not established.')
    warn('adjacent_trees_may_merge', `${connectivity}-connected logs may combine more than one tree; this is not an exact whole-tree segmentation.`)
    if (connectivity === 6) warn('diagonal_logs_may_be_missed', 'Six-connected traversal excludes branches that touch only at an edge or corner.')
    if (new Set(logs.map(log => log.name)).size > 1) warn('mixed_log_types', 'The candidate contains more than one log block name.')
    if (logs.some(log => log.name.startsWith('stripped_'))) warn('stripped_logs_present', 'Stripped logs indicate modified wood and may belong to an artificial structure.')
    if (observedLeaves.some(leaf => leaf.persistent === true)) warn('persistent_leaves_present', 'Persistent leaves are consistent with placed leaves and do not establish a natural canopy.')
    if (leafRadius === 0) warn('leaf_evidence_disabled', 'Nearby leaves were not queried because leafRadius is zero.')
    else if (!complete.leaves) warn('leaf_evidence_incomplete', 'The bounded or partly unknown neighborhood cannot establish the presence or absence of a full canopy.')
    else if (!observedLeaves.length) warn('no_leaf_evidence', 'No leaves were observed within the queried radius; this could be a structure, dead trunk, or tree with a more distant canopy.')
  }
  if (unknown.size) warn('unknown_boundary', 'Unavailable cells are unknown, not air; the candidate or leaf evidence may continue into them.')
  if (reasons.size) warn('bounded_query', 'One or more query limits prevented further inspection; the returned logs and leaves are a bounded subset.')

  return {
    kind: 'tree_candidate_query',
    status,
    seed: origin,
    connectivity,
    includeMixedLogs,
    bounds,
    limits: { maxLogs, maxDistance, maxReads, leafRadius },
    logs,
    logTraversalComplete: complete.logs,
    leafEvidence: {
      enabled: leafRadius > 0,
      radius: leafRadius,
      count: observedLeaves.length,
      leaves: observedLeaves,
      complete: status === 'candidate' && complete.leaves,
      persistentCount: observedLeaves.filter(leaf => leaf.persistent === true).length,
      nonPersistentCount: observedLeaves.filter(leaf => leaf.persistent === false).length,
      unknownPersistenceCount: observedLeaves.filter(leaf => leaf.persistent === null).length
    },
    unknownBoundaries: [...unknown.values()].map(p => ({ x: p.x, y: p.y, z: p.z, phases: [...p.phases] })),
    truncated: reasons.size > 0,
    truncationReasons: [...reasons],
    uncertainty,
    stats
  }
}

module.exports = { queryTreeCandidate }
