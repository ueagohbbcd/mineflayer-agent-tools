// Step 1: both kinds of action, on one connection, submitted one by one.
export default async function scenario (h) {
  await h.bash('node main.mjs', { background: true })
  await h.bash('sleep 5; node game.mjs status')
  await h.bash('node wait.mjs', { background: true })
  await h.bash('node game.mjs task tasks/water-steps.mjs')
  await h.bash('node game.mjs task tasks/dive.mjs')
  h.note('模型想了一会儿；这段时间 idle 和规则维持角色')
  await h.bash('sleep 6; node game.mjs status')
  await h.bash('node game.mjs task tasks/cross.mjs')
  await h.bash('node game.mjs task tasks/wall.mjs')
  await h.bash('node game.mjs task tasks/broken.mjs')
  await h.bash('node game.mjs task tasks/after-error.mjs')
  h.note('同一批里的通知要等回合结束才送到')
  await h.endTurn()
  await h.bash('node game.mjs stop')
}
