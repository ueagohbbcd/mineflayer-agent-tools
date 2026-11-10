# 架构：每个地方起什么作用

先读这份了解整体，再去各目录的 README 看细节。为什么这样设计见 [principles.md](principles.md)，背后的事实见 [lessons.md](lessons.md)。

## 运行时的样子

```
模型（在某个 harness 里，只有 shell）
  │  后台运行：node game.mjs run tasks/x.mjs      前台或后台：node game.mjs wait
  │  随时：cancel / query / status / stop
  ▼
game.mjs（每条命令一个短进程）
  │  Unix socket：.game/main.sock
  ▼
main.mjs（常驻进程，持有 bot，玩家项目里的一个可编辑文件）
  ├─ 核心 host：一个作业、一个控制者、退出流程、唤醒标记、报告函数
  │     控制者三选一：任务（模型写的）｜反射（defend、escape、eat）｜idle
  ├─ 观察器：听 bot 的事件，写记录、提供报告、在危险时请求抢占
  ├─ 插件适配：pathfinder、pvp、auto-eat、armor-manager、tool、collectblock
  └─ bot（Mineflayer）──► Minecraft 服务器

文件（留下来的东西）：records/journal.jsonl（这一局的时间线）、records/*.jsonl、records/tasks/、notes/、tasks/、.game/blocked.json
```

模型看不见游戏。它知道的一切来自三处：`run` 的输出、`wait` 的报告、自己发起的查询和截图。

## 一个作业的一生

1. 模型写一个任务文件，`run` 把它提交给 main。核心让当前控制者（通常是 idle）走退出流程，然后运行任务。
2. 任务直接操作 bot。`ctx.log` 的每一行实时出现在 `run` 的输出里。
3. 作业以四种方式之一结束：任务返回（完成）或抛错（失败）；模型 `cancel` 或提交了新作业；反射抢占（被打到低血量、头卡进方块）；死亡。
4. 无论哪种，核心都做同一件事：发退出信号，停下游戏动作，等任务返回，然后按记录下来的安排接着做（启动反射、结束作业、转 idle）。
5. 作业结束会唤醒 `wait`。`wait` 返回时，核心依次调用报告函数，把原因、现状、血量、周围、受伤、背包变化拼成一份文本。
6. 模型读报告，决定下一步，提交下一个作业。两个作业之间由 idle 保命。

## 仓库里每个地方的作用

| 地方 | 作用 | 谁在什么时候用 |
| --- | --- | --- |
| `game/lib/host.mjs` | 核心：作业、控制者、退出流程、唤醒、报告，和一个事件出口。与游戏无关 | main 进程全程；极少改动 |
| `game/lib/server.mjs`、`game/bin/game.mjs` | socket 两端：六个命令 | 每条命令 |
| `game/lib/plugins.mjs` | 生态插件的加载、默认设置和已知怪行为的处理 | main 启动时和每次退出流程；升级插件时看这里 |
| `game/lib/` 其余 | 给模型看的措辞、查询加载、合成修复、1.21.1 兼容 | 核心和模板调用 |
| `game/observers/` | 报告函数和记录器：状态、周围、受伤、聊天、探索；`journal` 把核心事件写成时间线 `records/journal.jsonl`，`review` 从中算出一页回顾 | `wait` 返回时；持续写 `records/`；回顾一局时 `node report.mjs review` |
| `game/experimental/` | 还在试用的控制逻辑：反射、idle、危险时请求抢占、走路、合成；附实机记录 | 模板默认接上；模型可以复制改写 |
| `game/template/` | 玩家项目的起点：`main.mjs`、玩家的一页 `AGENTS.md`、示例任务 | 开新项目时整个复制 |
| `game/observation/`、`game/queries/`、`game/visual/` | 只读地看世界：快照、可达范围、地形、截图 | 模型按需用 `query` 调用 |
| `game/dev/` | 开发者在真实服务器上验证用：RCON、场景清单、观察脚本 | 改了核心、插件或试验区之后 |
| `examples/` | 可直接运行或复制的查询和任务，每个演示一种做法 | 模型按需 |
| `skills/`、`bundle/` | 给游玩模型的专题知识；bundle 是合成一个 skill 的版本，由脚本生成 | 模型按需查阅 |
| 根目录的库（`index.js`、`reader`、`queries`、`live`、`watchdog`、`lib/`、`renderers/`） | 被动的工具：区块历史、有界查询、离线渲染、看门狗；不依赖 `game/` | 被 `game/` 和外部项目调用 |
| `docs/` | 理念、教训、范围、本文、自迭代流程，以及各个库的说明 | 贡献者 |
| `test/` | 替身 bot 的顺序测试、socket 测试、库的单元测试 | `npm test` |

依赖方向：核心 ← 游戏函数库 ← 试验区 ← 模板；根目录的库在最底下，谁也不依赖。

## 玩家项目里有什么

| 文件 | 作用 |
| --- | --- |
| `AGENTS.md` | 常驻在模型上下文里的一页：工作循环、任务约定、命令、提醒 |
| `main.mjs` | 接线：用哪些反射、idle、报告、观察器、插件。属于玩家，可以改 |
| `tasks/`、`queries/` | 模型写的任务和查询 |
| `notes/` | 这个世界的目标、地点、尝试 |
| `records/` | 观察器写的机器记录：`journal.jsonl` 是这一局的时间线，`tasks/` 是提交过的任务文件的各个版本 |
| `.game/` | socket 和卡死标记，运行时产物 |

## 想改一样东西时去哪里

| 想做的事 | 去哪里 |
| --- | --- |
| 改变角色在危险时的反应 | `game/experimental/reflexes.mjs`、`danger-preempt.mjs`，然后照 `game/dev/SCENARIOS.md` 重跑相关场景 |
| 让 `wait` 多报一样东西 | 在 `game/observers/` 加一个报告函数，在模板 `main.mjs` 里注册 |
| 处理某个插件的怪行为 | `game/lib/plugins.mjs`，并在教训里记一条 |
| 给游玩模型加一条提醒 | `game/template/AGENTS.md`（一句话）或对应的 skill（有实质内容） |
| 加一种看世界的方式 | `game/observation/` 或 `examples/` 里的一个查询 |
| 改交接或唤醒的规则 | `game/lib/host.mjs`；先读理念第 3、4 条，改完补替身测试并重跑生命周期场景 |
