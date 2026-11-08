// SPDX-License-Identifier: MIT
// Pathfinder movements that only walk, jump, swim and climb: no digging, no
// placing blocks, no pillaring. A task that wants digging turns it on itself.
import pathfinderPkg from 'mineflayer-pathfinder'
const { Movements } = pathfinderPkg

export function walkingMovements (bot) {
  const moves = new Movements(bot)
  moves.canDig = false
  moves.allow1by1towers = false
  moves.scafoldingBlocks = []
  return moves
}
