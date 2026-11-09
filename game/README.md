# game：一个进程持有角色

设计见项目文件 `plans/minecraft-toolkit-minimal-design.md`。核心只做五件事：连接并运行任务文件；任务、服务、idle 之间按顺序交接；Unix socket 通信；唤醒（没有 wait 时保存标记）；wait 返回时拼接已注册的报告函数。

## 组成

| 文件 | 作用 |
| --- | --- |
| `lib/host.mjs` | 核心，与游戏无关。`createHost(bot, { dir, services, idle, cleanup })`：一项工作、一个控制者、一套退出流程、唤醒标记、报告函数 |
| `lib/describe.mjs` | 核心给模型的文字：现在的状态、工作怎么结束、`run`/`cancel`/`status`/`wait` 打印的摘要 |
| `lib/query.mjs` | 重新加载任务和查询文件；`runQuery` 在工作之外运行只读查询 |
| `lib/server.mjs` | 单实例 lock（连接服务器前检查）、Unix socket、主线程卡死检测（复用 `watchdog.js` 的 worker，写 `.game/blocked.json`） |
| `lib/plugins.mjs` | 生态插件的适配：加载 pathfinder、pvp、auto-eat、armor-manager、tool、collectblock（可选的没装就跳过）；只走路的 Pathfinder 设置（不挖、不搭），pvp 和 collectblock 的 `movements` 设为 null；退出流程里的游戏清理 `stopGameActions` |
| `lib/crafting-fix.mjs` | 1.21.1 连续合成错乱的修复：`bot.craft` 之后关窗口、清合成格和光标 |
| `lib/minecraft-compat.mjs` | 1.21.1 配方包解析修正 |
| `observers/` | 报告函数：`statusReport`（血、饥饿、氧气、时间、位置、装备、背包变化、死亡）、`radarReport`、`watchDamage`（伤害类型）、`watchChat`（私聊和点名会唤醒）；记录器 `explore`、`radar` 写 `records/` |
| `candidates/` | 候选控制逻辑（服务、idle、主动接管、goto、合成核对），还不是例程，见 [candidates/README.md](candidates/README.md) |
| `template/` | 玩家项目的起点：`AGENTS.md`（玩家的一页说明，任务约定的唯一来源，`npm run build:bundle` 把它生成进 `skills/mineflayer-game/SKILL.md`）、`main.mjs`（可编辑；调用 `loadPlugins`，把 `stopGameActions` 作为清理传给核心）、`tasks/example.mjs`、`game.mjs`、`report.mjs` |
| `bin/game.mjs` | `run`、`wait`、`cancel`、`query`、`status`、`stop` |
| `observation/`、`queries/`、`visual/` | 只读观察函数、快照查询、截图渲染器 |
| `dev/` | 本地验证：RCON、场地、测试任务 |

## 约定

- **一项工作。** `run` 提交工作并跟随到结束。命令进程被杀只断开输出，取消要用 `cancel`。新提交替换正在运行的工作。
- **一个控制者。** 同一时刻只有任务、服务、idle 中的一个控制角色。控制者记录 `phase`（`running`、`exiting`、`stuck`），核心另记一个 `next`：退出之后做什么。
- **退出流程。** 取消、换工作、接管、死亡都走同一套：请求者在 `next` 里写下之后的安排，中止 `ctx.signal` → 运行 `ctx.cleanup` 登记的函数和注入的游戏清理 → 等控制者的 promise 结束 → 唯一的 settle 函数执行 `next`：先启动排队的服务，否则从入口重启任务，否则结束工作；然后启动新工作或 idle。后来的请求按优先级覆盖先前的：死亡 > 取消 = 换工作 > 接管，所以取消、换工作、死亡都会撤掉排队的服务。请求可以重复，只退出一次。
- **不退出的控制者。** `graceMs`（5 秒）内没结束就仍是控制者、标为 `stuck`，唤醒模型，消息里带任务最后一行输出和退出规则；之后它结束时照常执行 `next`。兜底是重启 main，核心不包装 bot。
- **任务约定。** `export default async function task(bot, ctx)`；基本成员 `ctx.args`、`ctx.log`、`ctx.signal`，退出规则只有一句：await 之后 `ctx.signal.aborted` 为真就返回；返回值是结果，抛错是失败。候选里的 `goto`、`craftChecked` 和服务自己检查信号。进阶成员：`ctx.cleanup(fn)`、`ctx.wake(reason)`、`ctx.takeover(name, opts)`、`ctx.checkpoint(services)`、`ctx.attempt`。
- **接管。** 默认是停止型：服务结束后工作结束，报告写明原因，模型决定是否重新提交。暂停型（`ctx.checkpoint({ eat: 'pause' })`）是可选的进阶用法：服务结束后任务从入口重新运行，`ctx.attempt` 加一，`run` 命令不退出。
- **死亡** 结束工作、撤掉排队的服务和重启；重生后才进入 idle。服务迟到的完成不会重新拉起工作。
- **唤醒。** 工作结束、死亡、重生、接管、卡住、私聊或点名都会唤醒。没有 wait 时保存标记，下一次 `wait` 立即返回；多次唤醒合并（原因最多 8 条）；收报告期间来的唤醒留给下一次。工作结束是否已报告与标记分开记。
- **报告。** `host.addReport(name, fn)` 注册返回文本的函数；`wait` 依次调用并拼接，某个出错或超时只打印一行错误。
- **查询** 与工作并行，只读是约定；超时只保证调用方不再等。

服务是 `{ check?(bot), run(bot, ctx) }`。运行产物：`.game/blocked.json`、`records/*.jsonl`。

## 测试

- `test/game/host.test.mjs`：用替身 bot（EventEmitter）检查核心的顺序和生命周期，不连 Minecraft。
- `test/game/server.test.mjs`：真实的 socket 和子进程（`fixtures/fake-main.mjs`），检查 run、wait、cancel、客户端断开、主线程卡死。
- 本地服务器实测：官方 1.21.1 server.jar，online-mode=false，rcon 密码 test。测试项目复制整个 `template/`，`node_modules` 指向本仓库，`node game/dev/rcon.mjs <命令>` 布置场景。实测记录见 [candidates/README.md](candidates/README.md)。
