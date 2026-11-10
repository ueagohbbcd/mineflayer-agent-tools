# 实机场景清单

在本地官方 1.21.1 服务器上重复验证核心、反射和 idle 的清单。每项写目的、布置、预期和怎么判断通过；结果记在 [../experimental/README.md](../experimental/README.md) 的实机记录里，写明日期、次数和没跑的原因。

只记真实看到的东西：判断依据是 `run`、`wait`、`status` 的原文，查询结果，RCON 的回复和服务器日志。

## 共用准备

- 服务器：官方 server.jar 1.21.1，`online-mode=false`，普通难度，RCON 端口 25575、密码 `test`。RCON：`node <仓库>/game/dev/rcon.mjs "<命令>" ...`（每个参数一条命令）。
- 测试项目：复制整个 `game/template/`，`node_modules` 指向本仓库，把 `game/dev/tasks/*.mjs` 复制进项目的 `tasks/`。环境变量 `MF_VERSION=1.21.1 MF_USERNAME=Scen`。下面的命令都在测试项目目录里运行。
- 启动 main：`setsid nohup node main.mjs > main.log 2>&1 &`；改了 `main.mjs` 或试验区代码要 `node game.mjs stop` 后重新启动。
- 竞技场（战斗和大部分生命周期场景用）：y=120 石头平台，x -51..29、z -206..-126，y 121..123 玻璃围墙。检查：`execute if block -46 120 -165 stone`、`execute if block -51 122 -165 glass`。重建：
  ```
  forceload add -51 -206 29 -126
  fill -51 120 -206 29 120 -126 stone
  fill -50 121 -205 28 125 -127 air
  fill -50 126 -205 28 130 -127 air
  fill -51 121 -206 29 123 -206 glass
  fill -51 121 -126 29 123 -126 glass
  fill -51 121 -206 -51 123 -126 glass
  fill 29 121 -206 29 123 -126 glass
  ```
- 每个场景开始前：`time set 18000`、`gamerule doDaylightCycle false`、`gamerule doMobSpawning false`、`kill @e[type=!player]`、`tp Scen -46.5 121 -165.5 -90 0`、`clear Scen`、`effect clear Scen`、`effect give Scen instant_health 1 5`；有积压的唤醒先 `node game.mjs wait` 取走。
- 低血量：`damage Scen <20-血量> minecraft:generic`。要血量保持不变时加 `gamerule naturalRegeneration false`，结束后改回 `true`。
- 死亡计数：`scoreboard objectives add fightDeaths deathCount`，`scoreboard players get Scen fightDeaths`。角色立即重生，只看 `status` 的 `alive` 会漏掉死亡。

## 一、启动和单实例

### 1. 启动 main
- 目的：main 进入游戏，idle 接手，插件都在。
- 布置：启动 main；`node game.mjs status`；`node game.mjs query <仓库>/game/dev/queries/plugins.mjs`。
- 预期：`main.log` 有"已进入游戏"；控制者 idle；六个插件都在，`canDig` false、`allow1by1towers` false，pvp 和 collectblock 的 `movements` 为 null。
- 通过：以上逐项在输出里看到。

### 2. 一个短作业
- 目的：`run` 跟随到结束，`wait` 带报告。
- 布置：`node game.mjs run tasks/example.mjs 0 121 -151`，之后 `node game.mjs wait`。
- 预期：几秒内完成，结果是站的位置；`wait` 立即返回，有唤醒原因、最近结束的作业、状态、周围。
- 通过：结果坐标在目标 1 格内，`wait` 不阻塞。

### 3. 同一目录第二个 main
- 布置：main 运行时再执行 `node main.mjs`。
- 预期：打印"这个项目的 main 已在运行（pid …）"，退出码 0，原 main 不受影响。

### 4. main 被 `kill -9` 后重启
- 布置：`kill -9 <main 的 pid>`；`node game.mjs status`；再启动 main。
- 预期：`status` 打印"main 没有在运行"；新 main 删掉残留的 `.game/main.sock`，进入游戏，`status` 正常。

### 5. `stop`
- 布置：`node game.mjs stop`。
- 预期：几秒内 main 退出，服务器上 Scen 下线（`list`），socket 文件删除。

## 二、战斗（`game/dev/fight.mjs`）

`node <仓库>/game/dev/fight.mjs <skeleton|spider|zombie|zombie2|creeper> <idle|goto> [次数=3] [剑=iron_sword] [血量=20]`，main 运行时在测试项目目录里执行。每次布置见脚本开头（午夜、关自然刷怪、清怪、tp 到出发点、只给剑、满血加 saturation、按需扣血），怪在出发点东 12 格（`zombie` 正好在巡逻路上）；`goto` 模式提交 `tasks/patrol.mjs` 在 A(-46.5 121 -165.5) 和 B(24 121 -166) 之间来回，段数由 `FIGHT_LEGS`（默认 6）给；`FIGHT_NO_REGEN=1` 关自然回血。之后脚本只观察：每 0.5 秒读 `status`、`queries/vitals.mjs`、RCON 的怪数和死亡计数，每次追加一行到 `fight-results.jsonl`，把之后 `wait` 的报告存进 `fight-reports.log`。

每项记录：开始、最低、结束血量，谁死了，用时，离出发点的距离，哪个控制者和反射跑过（`controllers`、`acts`），作业怎么结束。血量采样间隔 0.6 秒左右，最低值以 `wait` 报告"受伤"段的最低血量为准。

### 6. 骷髅、蜘蛛、两只僵尸，满血铁剑
- 布置：`fight.mjs skeleton idle`、`fight.mjs skeleton goto`，`spider`、`zombie2` 同样，`FIGHT_LEGS=2`。
- 预期：没有死亡；idle 时 pvp 还手杀死怪；作业中作业能完成，作业后 idle 处理剩下的怪。
- 通过：3 次都没死（死亡计数不变），怪数归零或说明原因。

### 7. 两只僵尸，木剑 10 血（逃跑和回血）
- 布置：`fight.mjs zombie2 idle 3 wooden_sword 10`。
- 预期：不死；`defend` 低于 8 血开始逃，逃时不朝 6 格内的怪跑，回到 14 血以上或 12 格内没有怪才停；被逼到角落时还手。
- 通过：3 次死亡计数不变；`acts` 里 pvp 和逃跑（只有 `goal`）不在几秒内反复交替。

### 8. 苦力怕
- 布置：`fight.mjs creeper idle`；`FIGHT_LEGS=2 fight.mjs creeper goto`。
- 预期：idle 时角色在 7 格内躲开苦力怕，不去打它，没有爆炸伤害；作业中作业不被打断。
- 通过：idle 的最低血量 20；`acts` 里没有 `pvp`。

### 9. 骷髅，木剑 10 血
- 布置：`fight.mjs skeleton idle 1 wooden_sword 10`；`FIGHT_LEGS=2 fight.mjs skeleton goto 1 wooden_sword 10`。
- 预期：不死；作业中中箭不一定抢占（抢占要低于 12 血）。
- 通过：死亡计数不变，报告的受伤段有 `skeleton` 来源。

### 10. 作业中受伤被抢占
- 布置：`FIGHT_NO_REGEN=1 FIGHT_LEGS=2 fight.mjs zombie goto 3 iron_sword 11`。
- 预期：僵尸第一下打到 12 血以下时 `run` 打印"[抢占] defend 抢占（被 zombie 打到 N 血），之后结束作业、转 idle"；任务退出，`defend` 打或逃；之后"[抢占] defend 结束：…"，作业以"被 defend 抢占后结束"结束，转 idle；`wait` 报告有两条唤醒原因和"抢占的反射"一行。
- 通过：`fight-results.jsonl` 的 `jobEnd` 是"被 defend 抢占后结束…"，`controllers` 依次是 task、reflex:defend、idle；保存报告原文。僵尸没打中时这一次不算，补跑。

## 三、夜里 idle

### 11. 野外一夜
- 布置：`node <仓库>/game/dev/night.mjs 400 -100 5`（沙漠平地；脚本开自然刷怪、`spreadplayers` 到地面、时间 18000 不走、石剑和 8 个面包、满血，观察 5 分钟，结果追加到 `night-results.jsonl`，报告存 `night-reports.log`）。跑 2 次。
- 预期：活过 5 分钟；受伤后吃面包回血；不追着怪离开出发点太远。
- 通过：死亡计数不变；记录最低血量、最远距离（超过 20 格算走远）、吃掉的面包数（之后查询背包）。

## 四、作业生命周期

都在竞技场里做，从出发点开始；"长路"是 `tasks/patrol.mjs -46 121 -166 24 121 -166 6`。

### 12. 杀掉 `run` 进程，作业继续，`cancel` 结束
- 布置：后台运行长路的 `run`，几秒后 `kill` 这个 `run` 进程；`status`；然后 `node game.mjs cancel`。
- 预期：杀掉 `run` 后 `status` 仍显示作业在进行、角色在走；`cancel` 后作业以"已取消"结束，角色停下，idle 接手。
- 通过：两次 `status` 和查询的位置变化。

### 13. 抢占请求后立刻取消
- 布置：`gamerule naturalRegeneration false`，全套铁甲（`item replace entity Scen armor.chest with iron_chestplate` 等四条；没有护甲时，任务退出的 3 秒里角色站着挨打，会被打死），扣到 11 血；`run tasks/slow-exit.mjs 120`（收到退出后 3 秒才返回）；`summon zombie` 在角色身边；看到 `run` 输出"[抢占]"后 3 秒内 `cancel`。
- 预期：作业以"已取消"结束（不是"被 defend 抢占后结束"）；`defend` 不启动、不占着已取消的作业；之后 idle 控制（idle 自己会还手）。
- 通过：`run` 的最后一行和 `wait` 报告的作业结束原因；`status` 控制者是 idle。

### 14. `defend` 占着作业时取消
- 布置：同 10 的布置（`summon zombie -34.5 121 -165.5` 在路上、11 血、关回血），加铁胸甲和铁护腿，手动提交长路，看到"[抢占] defend 抢占"后 `cancel`。
- 预期：`defend` 退出，作业以"已取消"结束，idle 接手。
- 通过：`cancel` 的回复、`status`、`wait` 报告。

### 15. `defend` 打架时提交新作业
- 布置：同 14，看到"[抢占] defend 抢占"后提交 `run tasks/example.mjs -40 121 -150`。
- 预期：`defend` 退出，原作业以"被新作业替换"结束，新作业立即开始。僵尸还在身边时，新作业可能再被 `defend` 抢占。
- 通过：两个作业的结束原因和新作业的开始时间。

### 16. 不理退出信号的任务 + `cancel`
- 布置：`run tasks/ignore-cancel.mjs`，1 秒后 `cancel`。
- 预期：5 秒后标为卡住并唤醒，消息里有任务最后一行输出（"等 12 秒，不看退出信号"）和退出规则；仍是控制者；12 秒时任务返回，"终于退出了"的唤醒，作业以取消结束，转 idle。
- 通过：`wait` 报告的两条唤醒原文，`status` 的 phase 先 `stuck` 后 idle。

### 17. 作业中 `/kill`
- 布置：运行长路，几秒后 RCON `kill Scen`。
- 预期：作业以死亡结束，不重跑；重生后 idle 才开始；报告有死亡位置和重生位置。
- 通过：`run` 最后一行、`wait` 报告的状态段。

### 18. 走路时饿了
- 布置：两次：长路不带 `eat`；长路末尾加 `eat`。都先 `effect give Scen hunger 60 50`，背包给 8 个面包。
- 预期：不带 `eat` 时作业不重跑，一直走完（饥饿交给作业结束后的 idle）；带 `eat` 时饥饿到 14 以下任务退出、`eat` 吃到 18 以上、"[重跑] 第 2 次尝试"，`run` 一直跟着。
- 通过：`run` 的输出和结果里的 `attempt`。

### 19. 头在方块里
- 布置：给铁锹，`setblock <头部所在格> dirt`（站在出发点时是 `-47 122 -166`）。
- 预期：`in_wall` 伤害，`escape` 抢占（或 idle 里直接 `escape`），换铁锹挖开。
- 通过：查询头部所在格变空，报告受伤段有 `in_wall`。

### 20. 打架和收集之后仍然只走路
- 布置：一次战斗（场景 6 任一次）之后，和 `run tasks/collect-logs.mjs 3`（附近有原木，例如 `fill -40 121 -160 -40 123 -160 oak_log`）之后，各查询一次 `queries/plugins.mjs`。
- 预期：`canDig` false、`allow1by1towers` false、pvp 和 collectblock 的 `movements` 为 null。
- 通过：查询原文。

### 21. 连续 20 次合成
- 布置：身边放工作台，`give Scen oak_log 16`、`give Scen coal 4`，`run tasks/craft-checked.mjs`；之后 `clear Scen <物品> 0` 读服务器数量。
- 预期：20 次全部成功，bot 背包和服务器一致。
- 通过：任务结果和 RCON 数量逐项相同。

### 22. 没人 wait 时私聊
- 布置：没有 `wait` 在等时，RCON `tell Scen 你好`；然后 `wait`。
- 预期：`wait` 立即返回，唤醒原因是私聊，报告聊天段有原文。

### 23. main 被 `busy-forever` 卡住时 `stop`
- 布置：`run tasks/busy-forever.mjs`（死循环，不回事件循环）；`status`；`stop`。
- 预期：`status` 连不上或报告主线程卡住（`.game/blocked.json`）；`stop` 用其中的 pid 结束 main，服务器上 Scen 下线；之后能正常启动 main。
- 通过：`stop` 的输出和 `list`。

## 五、时间线和回顾

### 24. 一局短游戏的时间线（`records/journal.jsonl`）和 `report.mjs review`
- 目的：时间线如实记下一局，回顾里的每个数字都能用自己做过的事和服务器日志核对。
- 布置：新测试项目（`records/` 为空），竞技场，`scoreboard objectives add jDeaths deathCount`。约 5 分钟里依次：`run tasks/example.mjs …` 完成；`run tasks/broken.mjs`（抛错）；自写一个走路任务，运行，改一行再运行；`run tasks/patrol.mjs …` 几秒后 `cancel`；`FIGHT_NO_REGEN=1 FIGHT_LEGS=2 fight.mjs zombie goto 1 iron_sword 11`（场景 10，`defend` 抢占）；作业中 RCON `kill`；中间穿插几次 `wait`（含一次私聊唤醒）；作业中 `kill -9` main，再启动 main 跑一个短作业；`node game.mjs stop`，再启动，作业中 `damage` 两次后 `kill`。之后 `node report.mjs review` 和 `node report.mjs review --json`。
- 预期：main 启动次数等于服务器日志里 joined 的次数，`kill -9` 那次算一次崩溃，`stop` 那次有 `main_stop`（退出码 0）；死亡次数和时间与日志的 "was killed" 和 `jDeaths` 相同，每次死亡有位置、致命伤害类型、当时的作业和控制者，死前 60 秒的事件里有那两次 `damage`；作业按结束方式的计数与 `run` 的最后一行逐个对得上；`records/tasks/` 里改过的任务有两份、没改过的只有一份；`wait` 送达次数等于实际调用 `wait` 并拿到报告的次数（`fight.mjs` 自己调用一次）；受伤计数与 `fight-results.jsonl` 的血量变化和 RCON 的 `damage` 次数相同。
- 通过：逐项核对后，在试验区记录里写下回顾原文的要点和核对结果。

