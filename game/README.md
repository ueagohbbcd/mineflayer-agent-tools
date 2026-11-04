# game：一个进程持有角色的轻量写法

第 1 步的实现（计划见项目文件 `plans/minecraft-toolkit-rebuild-plan-v4.md`）。和旧的 `runtime/`（mf、supervisor、TaskManager）并存，迁移完成后删除旧底座。

## 组成

| 文件 | 作用 |
| --- | --- |
| `template/main.mjs` | 可编辑的游戏主程序：init、规则表、idle。`node main.mjs [task.mjs ...]` 依次跑任务，然后闲置 |
| `lib/game.mjs` | `createGame(bot, { dir, rules, idle })`：一次一个任务，`steps(fn)` 预制主循环，任务结束清理 |
| `lib/rules.mjs` | 一张有序规则表，三个时段：steps 里第一条给 inputs 的接管本轮；插件独占时只告警；任务之间维持角色 |
| `lib/default-rules.mjs` | 首版规则：low-air、no-progress、repeat-death、repeat-no-path |
| `lib/notify.mjs`、`bin/wait.mjs` | notifyModel 追加 `.game/notices.jsonl`；`wait` 打印未送达的通知后退出，只有它标记已送达 |
| `dev/` | 本地验证：RCON、水道场地、测试任务、模拟 harness |

任务签名：`export default async function task(bot, { signal, steps, rules, notify, record, on })`。

- `steps(fn)`：每个 physicsTick 先过规则表；没有规则给出 inputs 时调用 `fn()`。`fn` 同步返回 setControlState 的键加可选 `look: { yaw, pitch }`，或 `{ done: true, result }`。没出现的键自动松开。
- `rules.disable(name)`：本任务内关掉某条规则的 inputs，告警照常。
- `on(emitter, event, fn)`：注册的监听器在任务结束时移除。

运行产物：`.game/results/<任务>.json`、`.game/notices.jsonl`、`records/{rules,tasks,events}.jsonl`。

## 本地验证

```sh
# 服务器：官方 1.21.1 server.jar，超平坦，online-mode=false，rcon 密码 test
node game/dev/setup-water.mjs
# 测试项目：复制 template/main.mjs 和 dev/tasks/，node_modules 指向本仓库
GAME_TASK_GAP_MS=6000 node game/dev/harness-sim.mjs <项目目录> tasks/water-steps.mjs tasks/dive.mjs tasks/cross.mjs tasks/wall.mjs tasks/broken.mjs tasks/after-error.mjs
```

`harness-sim.mjs` 模拟最简 harness：后台任务、前台调用和"后台任务结束"消息，按模型会看到的顺序打印。
