// Step 2: the local entry. Query during navigation, busy, cancel, new code on
// the same connection, a task that ignores cancel, a dropped submitter,
// watchdog notices with and without a waiting listener, a sync loop, stop.
export default async function scenario (h) {
  await h.bash('node main.mjs', { background: true })
  await h.bash('sleep 5; node main.mjs')
  h.note('第二个 main 应该直接退出，不再连接')
  let waiting = null
  const wait = async () => { waiting = await h.bash('node wait.mjs', { background: true }) }
  await wait()

  h.note('导航途中查询、忙碌、取消')
  await h.bash('node game.mjs task tasks/nav-far.mjs', { background: true })
  await h.bash('sleep 2; node game.mjs query queries/here.mjs')
  await h.bash('node game.mjs task tasks/after-error.mjs')
  await h.bash('node game.mjs cancel')
  await h.endTurn()

  h.note('同一连接上提交两版任务')
  await h.bash("printf 'export default async () => \"v1\"\\n' > tasks/hello.mjs && node game.mjs task tasks/hello.mjs")
  await h.bash("printf 'export default async () => \"v2\"\\n' > tasks/hello.mjs && node game.mjs task tasks/hello.mjs")

  h.note('任务不理会取消')
  await h.bash('node game.mjs task tasks/ignore-cancel.mjs', { background: true })
  await h.bash('sleep 1; node game.mjs cancel; node game.mjs status')
  await h.endTurn()

  h.note('提交命令被杀掉，任务继续，结束时用通知送结果')
  await h.bash('timeout 3 node game.mjs task tasks/nav-far.mjs; echo "exit $?"')
  await h.endTurn()
  await wait()

  h.note('看门狗告警：wait 已挂起')
  await h.bash('node game.mjs task tasks/stuck-wall.mjs', { background: true })
  await h.endTurn()
  await wait()
  await h.endTurn()

  h.note('看门狗告警：没有 wait 时发生，稍后才启动 wait')
  if (!waiting.done) h.kill(waiting)
  await h.bash('node game.mjs task tasks/stuck-wall.mjs')
  await wait()
  await h.endTurn()
  await wait()

  h.note('同步死循环 8 秒')
  await h.bash('node game.mjs task tasks/busy-loop.mjs', { background: true })
  await h.endTurn()
  await wait()
  await h.endTurn()

  h.note('卡死不返回，只能 stop 后重启')
  await h.bash('node game.mjs task tasks/busy-forever.mjs', { background: true })
  await h.bash('sleep 7; node game.mjs status', { timeoutMs: 15000 })
  await h.bash('node game.mjs stop')
  await h.endTurn()
  await h.bash('node main.mjs', { background: true })
  await h.bash('sleep 5; node game.mjs status; node game.mjs query queries/here.mjs')
  await h.bash('node game.mjs stop')
}
