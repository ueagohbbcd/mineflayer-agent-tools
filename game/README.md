# game：一个进程持有角色

整体结构见 [docs/architecture.md](../docs/architecture.md)，设计理由见 [docs/principles.md](../docs/principles.md)。核心只做五件事：连接并运行任务文件；任务、反射、idle 之间按顺序交接；Unix socket 通信；唤醒（没有 wait 时保存标记）；wait 返回时拼接已注册的报告函数。

## 用词

借用操作系统作业控制的说法，代码和文档只用这一套：

| 词 | 意思 |
| --- | --- |
| 作业（job） | 模型提交、`run` 跟随到结束的那件事，跨越多次尝试；像 shell 的一个作业 |
| 任务（task）、尝试（attempt） | 任务是任务文件；一次尝试是从入口把它运行一遍 |
| 反射（reflex） | 拿走角色的短小紧急行为（`defend`、`escape`、`eat`）；像中断处理程序 |
| 抢占（preempt） | 反射从正在运行的控制者手里拿走角色；像调度器抢占进程 |
| 安全点（safepoint） | 任务主动提供的、可以在此被抢占的位置；像运行时的安全点 |
| 之后（then） | 反射结束后：`restart` 从入口重跑任务（新的一次尝试），`end` 结束作业；像信号处理后重启或终止系统调用 |
| 控制者（controller） | 此刻持有角色的那一个：任务、反射或 idle；像占着 CPU 的进程 |
| 观察器（observer） | `main.mjs` 里接上的监听者，记录、报告或请求抢占；像内核里的事件钩子 |
| 试验（experimental） | 还在试用的控制逻辑，放在 `experimental/`；像内核的 staging 区 |

## 组成

| 文件 | 作用 |
| --- | --- |
| `lib/host.mjs` | 核心，与游戏无关。`createHost(bot, { dir, reflexes, idle, cleanup, onEvent })`：一个作业、一个控制者、一套退出流程、唤醒标记、报告函数，以及给记录时间线的观察器的一个事件出口 |
| `lib/describe.mjs` | 核心给模型的文字：现在的状态、作业怎么结束、`run`/`cancel`/`status`/`wait` 打印的摘要 |
| `lib/query.mjs` | 重新加载任务和查询文件；`runQuery` 在作业之外运行只读查询 |
| `lib/server.mjs` | Unix socket：`openEntry` 在连接服务器前绑定，绑定成功就是这个项目唯一的 main；`serve` 之后请求才交给核心。主线程卡死检测（复用 `watchdog.js` 的 worker，写 `.game/blocked.json`，带 pid 供 `stop` 使用） |
| `lib/plugins.mjs` | 生态插件的适配：加载 pathfinder、pvp、auto-eat、armor-manager、tool、collectblock（可选的没装就跳过）；只走路的 Pathfinder 设置（不挖、不搭），pvp 和 collectblock 的 `movements` 设为 null；退出流程里的游戏清理 `stopGameActions` |
| `lib/crafting-fix.mjs` | 1.21.1 连续合成错乱的修复：`bot.craft` 之后关窗口、清合成格和光标 |
| `lib/minecraft-compat.mjs` | 1.21.1 配方包解析修正 |
| `observers/` | 观察器和报告函数：`statusReport`（血、饥饿、氧气、时间、位置、装备、背包变化、死亡）、`radarReport`、`watchDamage`（伤害类型）、`watchChat`（私聊和点名会唤醒）；记录器 `explore`、`radar` 写 `records/`；`startJournal`（`journal.mjs`）把核心事件、main 的启动和停止、受伤、作业起止和死亡时的状态、每份 `wait` 报告写成这一局的时间线；`review.mjs` 从时间线算出一页回顾 |
| `experimental/` | 试验区的控制逻辑（反射、idle、危险时请求抢占的观察器、goto、合成核对），还不是例程，见 [experimental/README.md](experimental/README.md) |
| `template/` | 玩家项目的起点：`AGENTS.md`（玩家的一页说明，任务约定的唯一来源，`npm run build:bundle` 把它生成进 `skills/mineflayer-game/SKILL.md`）、`main.mjs`（可编辑；调用 `loadPlugins`，把 `stopGameActions` 作为清理传给核心）、`tasks/example.mjs`、`game.mjs`、`report.mjs` |
| `bin/game.mjs` | `run`、`wait`、`cancel`、`query`、`status`、`stop` |
| `bin/report.mjs` | 只读文件：`report.mjs [名称] [分钟]` 看记录器的记录；`report.mjs review [分钟] [--json]` 是这一局的一页回顾（概况、死亡、作业、控制者时间、反射、报告、受伤），`--json` 给对比试玩用的数字 |
| `observation/`、`queries/`、`visual/` | 只读观察函数、快照查询、截图渲染器 |
| `dev/` | 本地验证：RCON、场地、测试任务、战斗和夜里的观察脚本（`fight.mjs`、`night.mjs`）；场景清单 [dev/SCENARIOS.md](dev/SCENARIOS.md) |

## 约定

- **一个作业。** `run` 提交作业并跟随到结束。命令进程被杀只断开输出，取消要用 `cancel`。新提交替换正在运行的作业。作业 id 形如 `j1-<任务名>`。
- **一个控制者。** 同一时刻只有任务、反射、idle 中的一个控制角色。控制者记录 `phase`（`running`、`exiting`、`stuck`），核心另记一个 `next`：退出之后做什么。
- **退出流程。** 取消、换作业、抢占、死亡都走同一套：请求者在 `next` 里写下之后的安排，中止 `ctx.signal` → 运行 `ctx.cleanup` 登记的函数和注入的游戏清理 → 等控制者的 promise 结束 → 唯一的 settle 函数执行 `next`：先启动排队的反射，否则从入口开始新的一次尝试，否则结束作业；然后启动新作业或 idle。后来的请求按优先级覆盖先前的：死亡 > 取消 = 换作业 > 抢占，所以取消、换作业、死亡都会撤掉排队的反射。请求可以重复，只退出一次。
- **不退出的控制者。** `graceMs`（5 秒）内没结束就仍是控制者、标为 `stuck`，唤醒模型，消息里带任务最后一行输出和退出规则；之后它结束时照常执行 `next`。兜底是重启 main，核心不包装 bot。
- **任务约定。** `export default async function task(bot, ctx)`；基本成员 `ctx.args`、`ctx.log`、`ctx.signal`，退出规则只有一句：await 之后 `ctx.signal.aborted` 为真就返回；返回值是结果，抛错是失败。试验区的 `goto`、`craftChecked` 和反射自己检查信号。进阶成员：`ctx.cleanup(fn)`、`ctx.wake(reason)`、`ctx.preempt(name, opts)`、`ctx.safepoint(spec)`、`ctx.attempt`。
- **抢占。** `host.preempt(name, { then, reason })`。默认 `then: 'end'`：反射结束后作业结束，报告写明原因（结果里的 `preemptedBy`），模型决定是否重新提交。`then: 'restart'`（`ctx.safepoint({ eat: 'restart' })`）是可选的进阶用法：反射结束后任务从入口重跑，`ctx.attempt` 加一，`run` 命令不退出。
- **死亡** 结束作业、撤掉排队的反射和重跑；重生后才进入 idle。反射迟到的完成不会重新拉起作业。
- **唤醒。** 作业结束、死亡、重生、抢占、卡住、私聊或点名都会唤醒。没有 wait 时保存标记，下一次 `wait` 立即返回；多次唤醒合并（原因最多 8 条）；收报告期间来的唤醒留给下一次。作业结束是否已报告与标记分开记。
- **报告。** `host.addReport(name, fn)` 注册返回文本的函数；`wait` 依次调用并拼接，某个出错或超时只打印一行错误。
- **事件出口。** `createHost` 的 `onEvent(e)` 在提交作业、控制者开始和结束、抢占请求、卡住、作业结束、死亡、重生、唤醒、报告送达时收到一个小的普通对象（作业结束时就是 `run` 打印的摘要）；它抛的错被忽略。核心只有这一个出口，时间线由观察器 `journal.mjs` 写。
- **查询** 与作业并行，只读是约定；超时只保证调用方不再等。
- **单实例。** 绑定 socket 就是占位：已有 main 应答时，第二个 main 打印"已在运行"后退出；崩溃留下的 socket 文件没人应答（连接被拒），新的 main 删掉它重新绑定。核心接上之前到达的请求只得到"main 正在启动"。`status` 回复带 pid 和启动时间；`game.mjs` 连不上（ENOENT、ECONNREFUSED）就判定 main 没有在运行。

反射是 `{ check?(bot), run(bot, ctx) }`。运行产物：`.game/main.sock`、`.game/blocked.json`、`records/*.jsonl`（其中 `records/journal.jsonl` 是这一局的时间线：一条 main 启动之前没有停止记录就是崩溃）、`records/tasks/<任务名>-<哈希>.mjs`（每个提交过的任务文件的每个版本一份，作业那一行记着哈希）。

## 测试

- `test/game/host.test.mjs`：用替身 bot（EventEmitter）检查核心的顺序和生命周期（包括 `onEvent` 收到事件的顺序），不连 Minecraft。
- `test/game/review.test.mjs`：手写的一段时间线，检查回顾的计算（日志算术）；时间线是否如实记录了一局在服务器上检查。
- `test/game/server.test.mjs`：真实的 socket 和子进程（`fixtures/fake-main.mjs`），检查 run、wait、cancel、客户端断开、主线程卡死；同一目录的第二个 main 打印消息后退出；残留的 socket 文件被替换。
- 本地服务器实测：官方 1.21.1 server.jar，online-mode=false，rcon 密码 test。测试项目复制整个 `template/`，`node_modules` 指向本仓库，`node game/dev/rcon.mjs <命令>` 布置场景。实测记录见 [experimental/README.md](experimental/README.md)。
