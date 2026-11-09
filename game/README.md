# game：一个进程持有角色

设计见项目文件 `plans/minecraft-toolkit-minimal-design.md`。核心只做五件事：连接并运行任务文件；任务、服务、idle 之间按顺序交接；Unix socket 通信；唤醒（没有 wait 时保存标记）；wait 返回时拼接已注册的报告函数。

## 组成

| 文件 | 作用 |
| --- | --- |
| `lib/host.mjs` | 核心。`createHost(bot, { dir, services, idle })`：一项工作、一个控制者、一套退出流程、唤醒标记、报告函数 |
| `lib/server.mjs` | 单实例 lock（连接服务器前检查）、Unix socket、主线程卡死检测（复用 `watchdog.js` 的 worker，写 `.game/blocked.json`） |
| `lib/cleanup.mjs` | 退出流程里的公共清理：停寻路、PvP、按键、挖掘、使用物品，关窗口 |
| `lib/movements.mjs` | 只走路的 Pathfinder 设置（不挖、不搭），模板默认使用 |
| `lib/crafting-fix.mjs` | 1.21.1 连续合成错乱的修复：`bot.craft` 之后关窗口、清合成格和光标 |
| `lib/minecraft-compat.mjs` | 1.21.1 配方包解析修正 |
| `observers/` | 报告函数：`statusReport`（血、饥饿、氧气、时间、位置、装备、背包变化、死亡）、`radarReport`、`watchDamage`（伤害类型）、`watchChat`（私聊和点名会唤醒）；记录器 `explore`、`radar` 写 `records/` |
| `candidates/` | 候选控制逻辑（服务、idle、主动接管、goto、合成核对），还不是例程，见 [candidates/README.md](candidates/README.md) |
| `template/` | 玩家项目的起点：`main.mjs`（可编辑；加载 pathfinder、pvp、auto-eat、armor-manager、tool、collectblock，退出时恢复只走路的寻路设置）、`game.mjs`、`report.mjs` |
| `bin/game.mjs` | `run`、`wait`、`cancel`、`query`、`status`、`stop` |
| `observation/`、`queries/`、`visual/` | 只读观察函数、快照查询、截图渲染器 |
| `dev/` | 本地验证：RCON、场地、测试任务 |

## 约定

- **一项工作。** `run` 提交工作并跟随到结束：暂停型介入后任务从入口重新运行（`ctx.attempt` 加一），命令不退出；停止型介入在服务结束后退出。命令进程被杀只断开输出，取消要用 `cancel`。新提交替换正在运行的工作。
- **退出流程。** 取消、换工作、介入、死亡都走同一套：中止 `ctx.signal` → `ctx.checkpoint` 之后抛错 → 运行 `ctx.cleanup` 登记的函数和公共清理 → 等任务真正返回。可以重复请求，只执行一次。退出确认前不启动别的控制者；`graceMs`（5 秒）内没返回就保持控制者身份、标为卡住并唤醒，兜底是重启 main。
- **死亡** 结束工作、取消待执行的重启；重生后才进入 idle。服务迟到的完成不会重新拉起工作。
- **唤醒。** 工作结束、死亡、重生、介入、卡住、私聊或点名都会唤醒。没有 wait 时保存标记，下一次 `wait` 立即返回；多次唤醒合并（原因最多 8 条）；收报告期间来的唤醒留给下一次。工作结束是否已报告与标记分开记。
- **报告。** `host.addReport(name, fn)` 注册返回文本的函数；`wait` 依次调用并拼接，某个出错时只打印一行错误。
- **查询** 与工作并行，只读是约定；超时只保证调用方不再等。

任务签名：`export default async function task(bot, ctx)`，`ctx` 有 `args`、`log`、`signal`、`attempt`、`checkpoint(services)`、`cleanup(fn)`、`wake(reason)`、`takeover(name, opts)`。服务是 `{ check?(bot), run(bot, ctx) }`。

运行产物：`.game/results/<工作>.json`、`.game/blocked.json`、`records/*.jsonl`。

## 测试

- `test/game/host.test.mjs`：用替身 bot（EventEmitter）检查核心的顺序和生命周期，不连 Minecraft。
- `test/game/server.test.mjs`：真实的 socket 和子进程（`fixtures/fake-main.mjs`），检查 run、wait、cancel、客户端断开、主线程卡死。
- 本地服务器实测：官方 1.21.1 server.jar，online-mode=false，rcon 密码 test。测试项目复制 `template/*.mjs`，`node_modules` 指向本仓库，`node game/dev/rcon.mjs <命令>` 布置场景。实测记录见 [candidates/README.md](candidates/README.md)。
