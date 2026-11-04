// SPDX-License-Identifier: MIT
// Builds the local test course on a superflat 1.21 world (ground top y=-61):
// a 3-deep water channel x 10..49 along z=0, a stone wall at x=-8, and a
// 12x31 lake at x 60..71 (too wide to parkour over, too long to walk around).
import { rcon } from './rcon.mjs'

const replies = await rcon([
  'gamerule doDaylightCycle false',
  'time set day',
  'weather clear',
  'fill -12 -60 -6 55 -50 6 air',
  'fill -12 -63 -6 55 -62 6 dirt',
  'fill -12 -61 -6 55 -61 6 grass_block',
  'fill 10 -63 -1 49 -61 1 water',
  'fill -8 -60 -3 -8 -57 3 stone',
  'forceload add 56 -16 76 16',
  'fill 56 -60 -16 76 -50 16 air',
  'fill 56 -61 -16 76 -61 16 grass_block',
  'fill 60 -63 -15 71 -61 15 water',
  'setworldspawn 2 -60 0'
])
console.log(replies.join('\n'))
