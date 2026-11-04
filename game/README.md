# game：一个进程持有角色的轻量写法

重构计划 v4 的实现（计划见项目文件 `plans/minecraft-toolkit-rebuild-plan-v4.md`）。旧的 `runtime/`（mf、supervisor、TaskManager、日志库）已删除。

## 组成

| 文件 | 作用 |
| --- | --- |
| `template/main.mjs` | 可编辑的游戏主程序：lock、init、规则表、idle，最后 `serve(game)` 开放本地入口。放到 harness 后台运行 |
| `template/game.mjs`、`bin/game.mjs` | `task <file>`（结束时打印结果）、`query <file> [秒]`、`cancel`、`status`、`stop` |
| `lib/server.mjs` | 单实例 lock（连接服务器前就检查）、Unix socket、主线程卡死告警（复用 `watchdog.js` 的 worker） |
| `lib/game.mjs` | `createGame(bot, { dir, rules, idle })`：一次一个任务，`steps(fn)` 预制主循环，任务结束清理 |
| `lib/rules.mjs` | 一张有序规则表，三个时段：steps 里第一条给 inputs 的接管本轮；插件独占时只告警；任务之间维持角色 |
| `lib/default-rules.mjs` | 首版规则：low-air、no-progress、repeat-death、repeat-no-path |
| `lib/notify.mjs`、`bin/wait.mjs` | notifyModel 追加 `.game/notices.jsonl`；`wait` 打印未送达的通知后退出，只有它标记已送达 |
| `observation/` | 只读观察函数（快照、雷达、事件、开阔空间扫描、字符地图 reachMap、地点图），原 `runtime/observation/` |
| `observers/`、`bin/report.mjs` | chat、danger、explore、radar 观察器写 `records/<名称>.jsonl`；danger 的 urgent 条目和 MF_CHAT_WAKE 匹配的聊天也会通知。`node report.mjs [名称] [分钟]` 只读文件，不改任何状态 |
| `queries/snapshot.mjs` | 一次完整状态采样（原 `mf snapshot`） |
| `dev/` | 本地验证：RCON、水道场地、测试任务和查询、模拟 harness 及场景 |

约定：
- 一次一个任务，已有任务时 `task` 立即返回忙。提交命令一直连着时，结果只在这条命令里返回；提交端断开（超时、被杀）时任务继续，结束时用 notifyModel 送结果。
- `cancel` 是请求：中止 signal，结束 steps、松开按键，清掉寻路目标，停 pvp；任务真正结束后才交还角色。5 秒内没结束就报告需要重启。
- 查询与任务并行，只读是约定；超时只保证调用方不再等。
- 主线程卡在同步代码里时 socket 无法回复：worker 写通知，`status` 等命令 5 秒超时并提示用 `stop`（SIGTERM 不响应时 SIGKILL）。

任务签名：`export default async function task(bot, { args, log, signal, steps, rules, notify, record, on })`；查询签名 `query(bot, { args, log, signal, record, on })`。`log(...)` 的行进入结果（任务保留最后 30 行），查询命令先打印这些行再打印返回值。`examples/*.mjs` 可以直接 `node game.mjs task|query <toolkit>/examples/X.mjs 参数...`，也可以在任务里 import。

- `steps(fn)`：每个 physicsTick 先过规则表；没有规则给出 inputs 时调用 `fn()`。`fn` 同步返回 setControlState 的键加可选 `look: { yaw, pitch }`，或 `{ done: true, result }`。没出现的键自动松开。
- `rules.disable(name)`：本任务内关掉某条规则的 inputs，告警照常。
- `on(emitter, event, fn)`：注册的监听器在任务结束时移除。

运行产物：`.game/results/<任务>.json`、`.game/notices.jsonl`、`records/{rules,tasks,events}.jsonl`。

## 本地验证

```sh
# 服务器：官方 1.21.1 server.jar，超平坦，online-mode=false，rcon 密码 test
node game/dev/setup-water.mjs
# 测试项目：复制 template/*.mjs、dev/tasks/、dev/queries/，node_modules 指向本仓库
node game/dev/harness-sim.mjs game/dev/scenarios/step1.mjs <项目目录>
node game/dev/harness-sim.mjs game/dev/scenarios/step2.mjs <项目目录>
```

`harness-sim.mjs` 模拟最简 harness：后台任务、前台调用和"后台任务结束"消息，按模型会看到的顺序打印。
