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
- 预期：`main.log` 有 "joined the game"；控制者 idle；六个插件都在，`canDig` false、`allow1by1towers` false，pvp 和 collectblock 的 `movements` 为 null。
- 通过：以上逐项在输出里看到。

### 2. 一个短作业
- 目的：`run` 跟随到结束，`wait` 带报告。
- 布置：`node game.mjs run tasks/example.mjs 0 121 -151`，之后 `node game.mjs wait`。
- 预期：几秒内完成，结果是站的位置；`wait` 立即返回，有唤醒原因、最近结束的作业、状态、周围。
- 通过：结果坐标在目标 1 格内，`wait` 不阻塞。

### 3. 同一目录第二个 main
- 布置：main 运行时再执行 `node main.mjs`。
- 预期：打印 "main is already running for this project (pid …)"，退出码 0，原 main 不受影响。

### 4. main 被 `kill -9` 后重启
- 布置：`kill -9 <main 的 pid>`；`node game.mjs status`；再启动 main。
- 预期：`status` 打印 "main is not running"；新 main 删掉残留的 `.game/main.sock`，进入游戏，`status` 正常。

### 5. `stop`
- 布置：`node game.mjs stop`。
- 预期：几秒内 main 退出，服务器上 Scen 下线（`list`），socket 文件删除。

## 二、战斗（`game/dev/fight.mjs`）

`node <仓库>/game/dev/fight.mjs <skeleton|spider|zombie|zombie2|creeper> <idle|patrol> [次数=3] [剑=iron_sword] [血量=20]`，main 运行时在测试项目目录里执行。每次布置见脚本开头（午夜、关自然刷怪、清怪、tp 到出发点、只给剑、满血加 saturation、按需扣血），怪在出发点东 12 格（`zombie` 正好在巡逻路上）；`patrol` 模式提交 `tasks/patrol.mjs` 在 A(-46.5 121 -165.5) 和 B(24 121 -166) 之间来回，段数由 `FIGHT_LEGS`（默认 6）给；`FIGHT_NO_REGEN=1` 关自然回血。之后脚本只观察：每 0.5 秒读 `status`、`queries/vitals.mjs`、RCON 的怪数和死亡计数，每次追加一行到 `fight-results.jsonl`，把之后 `wait` 的报告存进 `fight-reports.log`。

每项记录：开始、最低、结束血量，谁死了，用时，离出发点的距离，哪个控制者和反射跑过（`controllers`、`acts`），作业怎么结束。血量采样间隔 0.6 秒左右，最低值以 `wait` 报告 damage 段的最低血量为准。

### 6. 骷髅、蜘蛛、两只僵尸，满血铁剑
- 布置：`fight.mjs skeleton idle`、`fight.mjs skeleton patrol`，`spider`、`zombie2` 同样，`FIGHT_LEGS=2`。
- 预期：没有死亡；idle 时 pvp 还手杀死怪；作业中作业能完成，作业后 idle 处理剩下的怪。
- 通过：3 次都没死（死亡计数不变），怪数归零或说明原因。

### 7. 两只僵尸，木剑 10 血（逃跑和回血）
- 布置：`fight.mjs zombie2 idle 3 wooden_sword 10`。
- 预期：不死；`fightOrFlee` 低于 8 血开始逃，逃时不朝 6 格内的怪跑，回到 14 血以上或 12 格内没有怪才停；被逼到角落时还手。
- 通过：3 次死亡计数不变；`acts` 里 pvp 和逃跑（只有 `goal`）不在几秒内反复交替。

### 8. 苦力怕
- 布置：`fight.mjs creeper idle`；`FIGHT_LEGS=2 fight.mjs creeper patrol`。
- 预期：idle 时角色在 7 格内躲开苦力怕，不去打它，没有爆炸伤害；作业中作业不被打断。
- 通过：idle 的最低血量 20；`acts` 里没有 `pvp`。

### 9. 骷髅，木剑 10 血
- 布置：`fight.mjs skeleton idle 1 wooden_sword 10`；`FIGHT_LEGS=2 fight.mjs skeleton patrol 1 wooden_sword 10`。
- 预期：不死；作业中中箭不一定抢占（抢占要低于 12 血）。
- 通过：死亡计数不变，报告的受伤段有 `skeleton` 来源。

### 10. 作业中受伤被抢占
- 布置：`FIGHT_NO_REGEN=1 FIGHT_LEGS=2 fight.mjs zombie patrol 3 iron_sword 11`。
- 预期：僵尸第一下打到 12 血以下时 `run` 打印 "[preempt] fightOrFlee preempts (hit by zombie, health N), then the job ends and idle takes over"；任务退出，`fightOrFlee` 打或逃；之后 "[preempt] fightOrFlee ended: …"，作业以 "ended after fightOrFlee preempted it" 结束，转 idle；`wait` 报告有两条唤醒原因和 "reflex fightOrFlee ended: …" 一行。
- 通过：`fight-results.jsonl` 的 `jobEnd` 是 "ended after fightOrFlee preempted it …"，`controllers` 依次是 task、reflex:fightOrFlee、idle；保存报告原文。僵尸没打中时这一次不算，补跑。

## 三、夜里 idle

### 11. 野外一夜
- 布置：`node <仓库>/game/dev/night.mjs 400 -100 5`（沙漠平地；脚本开自然刷怪、`spreadplayers` 到地面、时间 18000 不走、石剑和 8 个面包、满血，观察 5 分钟，结果追加到 `night-results.jsonl`，报告存 `night-reports.log`）。跑 2 次。
- 预期：活过 5 分钟；受伤后吃面包回血；不追着怪离开出发点太远。
- 通过：死亡计数不变；记录最低血量、最远距离（超过 20 格算走远）、吃掉的面包数（之后查询背包）。

## 四、作业生命周期

都在竞技场里做，从出发点开始；"长路"是 `tasks/patrol.mjs -46 121 -166 24 121 -166 6`。

### 12. 杀掉 `run` 进程，作业继续，`cancel` 结束
- 布置：后台运行长路的 `run`，几秒后 `kill` 这个 `run` 进程；`status`；然后 `node game.mjs cancel`。
- 预期：杀掉 `run` 后 `status` 仍显示作业在进行、角色在走；`cancel` 后作业以 "cancelled" 结束，角色停下，idle 接手。
- 通过：两次 `status` 和查询的位置变化。

### 13. 抢占请求后立刻取消
- 布置：`gamerule naturalRegeneration false`，全套铁甲（`item replace entity Scen armor.chest with iron_chestplate` 等四条；没有护甲时，任务退出的 3 秒里角色站着挨打，会被打死），扣到 11 血；`run tasks/slow-exit.mjs 120`（收到退出后 3 秒才返回）；`summon zombie` 在角色身边；看到 `run` 输出 "[preempt]" 后 3 秒内 `cancel`。
- 预期：作业以 "cancelled" 结束（不是 "ended after fightOrFlee preempted it"）；`fightOrFlee` 不启动、不占着已取消的作业；之后 idle 控制（idle 自己会还手）。
- 通过：`run` 的最后一行和 `wait` 报告的作业结束原因；`status` 控制者是 idle。

### 14. `fightOrFlee` 占着作业时取消
- 布置：同 10 的布置（`summon zombie -34.5 121 -165.5` 在路上、11 血、关回血），加铁胸甲和铁护腿，手动提交长路，看到 "[preempt] fightOrFlee preempts" 后 `cancel`。
- 预期：`fightOrFlee` 退出，作业以 "cancelled" 结束，idle 接手。
- 通过：`cancel` 的回复、`status`、`wait` 报告。

### 15. `fightOrFlee` 打架时提交新作业
- 布置：同 14，看到 "[preempt] fightOrFlee preempts" 后提交 `run tasks/example.mjs -40 121 -150`。
- 预期：`fightOrFlee` 退出，原作业以 "replaced by a new job" 结束，新作业立即开始。僵尸还在身边时，新作业可能再被 `fightOrFlee` 抢占。
- 通过：两个作业的结束原因和新作业的开始时间。

### 16. 不理退出信号的任务 + `cancel`
- 布置：`run tasks/ignore-cancel.mjs`，1 秒后 `cancel`。
- 预期：5 秒后标为卡住并唤醒，消息里有任务最后一行输出（"waiting 12 s, ignoring the abort"）和退出规则；仍是控制者；12 秒时任务返回，"has exited at last" 的唤醒，作业以取消结束，转 idle。
- 通过：`wait` 报告的两条唤醒原文，`status` 的 phase 先 `stuck` 后 idle。

### 17. 作业中 `/kill`
- 布置：运行长路，几秒后 RCON `kill Scen`。
- 预期：作业以死亡结束，不重跑；重生后 idle 才开始；报告有死亡位置和重生位置。
- 通过：`run` 最后一行、`wait` 报告的状态段。

### 18. 走路时饿了
- 布置：两次：长路不带 `eat`；长路末尾加 `eat`（`patrol.mjs` 的这个词给 `walkTo` 设 `checks: { eatWhenHungry: 'restart' }`）。都先 `effect give Scen hunger 60 50`，背包给 8 个面包。
- 预期：不带 `eat` 时作业不重跑，一直走完（饥饿交给作业结束后的 idle）；带 `eat` 时饥饿到 14 以下任务退出、`eatWhenHungry` 吃到 18 以上、"[restart] attempt 2, running the task from the top"，`run` 一直跟着。
- 通过：`run` 的输出和结果里的 `attempt`。

### 19. 头在方块里
- 布置：给铁锹，`setblock <头部所在格> dirt`（站在出发点时是 `-47 122 -166`）。
- 预期：`in_wall` 伤害，`digHeadFree` 抢占（或 idle 里直接 `digHeadFree`），换铁锹挖开。
- 通过：查询头部所在格变空，报告受伤段有 `in_wall`。

### 20. 打架和收集之后仍然只走路
- 布置：一次战斗（场景 6 任一次）之后，和 `run tasks/collect-logs.mjs 3`（附近有原木，例如 `fill -40 121 -160 -40 123 -160 oak_log`）之后，各查询一次 `queries/plugins.mjs`。
- 预期：`canDig` false、`allow1by1towers` false、pvp 和 collectblock 的 `movements` 为 null。
- 通过：查询原文。

### 21. 连续 20 次合成
- 布置：身边放工作台，`give Scen oak_log 16`、`give Scen coal 4`，`run tasks/craft-and-count.mjs`；之后 `clear Scen <物品> 0` 读服务器数量。
- 预期：20 次全部成功，bot 背包和服务器一致。
- 通过：任务结果和 RCON 数量逐项相同。
- 再加一次满足不了的请求：清空背包后 `give Scen oak_planks 2`，`run tasks/craft-sticks.mjs 8`（要 8 根木棍，2 块木板只够 4 根）。预期作业失败，错误是 "crafting stick: wanted 8, got 4 …" 或 "wanted 8, got 0 …"，带合成本身的错误；不能当成功。

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
- 布置：新测试项目（`records/` 为空），竞技场，`scoreboard objectives add jDeaths deathCount`。约 5 分钟里依次：`run tasks/example.mjs …` 完成；`run tasks/broken.mjs`（抛错）；自写一个走路任务，运行，改一行再运行；`run tasks/patrol.mjs …` 几秒后 `cancel`；`FIGHT_NO_REGEN=1 FIGHT_LEGS=2 fight.mjs zombie patrol 1 iron_sword 11`（场景 10，`fightOrFlee` 抢占）；作业中 RCON `kill`；中间穿插几次 `wait`（含一次私聊唤醒）；作业中 `kill -9` main，再启动 main 跑一个短作业；`node game.mjs stop`，再启动，作业中 `damage` 两次后 `kill`。之后 `node report.mjs review` 和 `node report.mjs review --json`。
- 预期：main 启动次数等于服务器日志里 joined 的次数，`kill -9` 那次算一次崩溃，`stop` 那次有 `main_stop`（退出码 0）；死亡次数和时间与日志的 "was killed" 和 `jDeaths` 相同，每次死亡有位置、致命伤害类型、当时的作业和控制者，死前 60 秒的事件里有那两次 `damage`；作业按结束方式的计数与 `run` 的最后一行逐个对得上；`records/tasks/` 里改过的任务有两份、没改过的只有一份；`wait` 送达次数等于实际调用 `wait` 并拿到报告的次数（`fight.mjs` 自己调用一次）；受伤计数与 `fight-results.jsonl` 的血量变化和 RCON 的 `damage` 次数相同。
- 通过：逐项核对后，在试验区记录里写下回顾原文的要点和核对结果。


## 六、例程、溺水、报告和崩溃提示

自然地形（种子 20261104），测试项目用自己的名字（2026-11-12 是 `Rout`），`scoreboard objectives add routDeaths deathCount`。用 `game/dev/tasks/stay.mjs` 把角色留在某处做一个作业。内存用 `ps -o rss= -p <main 的 pid>` 每秒记一次。`wait` 只在有待取的报告时才立即返回，先看 `status` 有没有 "a report is waiting"，否则它会一直等。

### 25. `digNearby`
- 布置：树林里（-505 103 830 一带有橡树）`run <仓库>/game/experimental/dig-nearby.mjs '*_log' 6 16`；地下矿：-242 63 559 附近的铁矿，先不给镐、再给石镐只走路、再加 `dig`；够不到的目标：RCON 用基岩围住一个矿，或在 40 格外半空放一个西瓜；保护：在矿前面放工作台和熔炉（`dig` 模式），另跑一次 `dig-nearby.mjs crafting_table 1`。
- 预期：原木全部挖到（站进挖空的树干够到上面）；缺镐时立即失败并说出需要哪些镐；只走路挖不到埋着的矿时逐个跳过、错误建议 `dig`；`dig` 挖到矿；够不到的目标在 30 秒内以原因失败；工作台和熔炉还在；要求挖工作台时立即拒绝。
- 通过：`run` 的输出、RCON `execute if block`、main 的 RSS 不持续上涨（2026-11-12：200–219 MB）；之后 `plugins.mjs` 查询 `canDig` false。

### 26. 溺水
- 布置：在自然地面里 `fill` 一个 3×3、7 格深的水井；`run tasks/stay.mjs 60`，2 秒后 tp 到井底。3 次：开口、井口盖一层石头（给镐）、再开口。另做一次井口盖基岩、背包清空（出不去），看重生后的空气值。再做一次 `digNearby` 挖开眼睛高度的矿、矿后面是水源。
- 预期：空气 10 时 `surfaceForAir` 抢占，作业以 "ended after surfaceForAir preempted it" 结束；出不去时死亡，重生后状态段 "air 20/20"；水源那次是任务自己请求抢占（回顾里 "from task"）。
- 通过：死亡计数、`run` 输出、`wait` 的状态段和受伤段。

### 27. `placeNear`
- 布置：平地一次；RCON 挖出 1 格宽、3 格和 5 格深的竖井，tp 到井底各一次。
- 预期：放在身边；井底挖开脚边一格墙放进去；`notes/places.md` 多一行。

### 28. `smeltItems`
- 布置：熔炉里的东西要用游戏里的操作留下（RCON 用 NBT 放进的输入 `CookTimeTotal` 是 0，服务器不会烧）：跑一次再 `cancel`。分别留下同种输入、别的输入、输出；另做一次身边没有熔炉。
- 预期：`cancel` 1 秒内结束；同种输入计入数量；别的输入退回背包；输出先取出；没有熔炉时先放一个。
- 通过：结果的 `took`、RCON `data get block <熔炉> Items`、`clear <名字> <物品> 0` 的数量。

### 29. `equipArmour`
- 布置：24 铁锭、4 木板，附近没有工作台：`craft-and-count.mjs crafting_table:1 iron_helmet:1 iron_chestplate:1 iron_leggings:1 iron_boots:1`，再 `equip-armour.mjs`；另一次身上穿较差的、背包里一好一差。
- 通过：RCON `execute if items entity <名字> armor.head iron_helmet` 等，状态段的 armor。

### 30. `climbToSurface`
- 布置：沙漠地下约 20 格挖一个 1×2 的空间，上面放一层沙砾；一次跑完；一次 14 秒时 `cancel` 再跑；一次在第一级台阶上方放沙砾柱。背包：石镐、石锹、16 圆石。
- 预期：到露天处；重跑从当时的位置接着爬；落下的沙砾再挖掉，没有窒息。

### 31. `sealIn`
- 布置：夜里（18000，开刷怪）沙漠平地，16 圆石，`seal-in.mjs`，之后 3 分钟每 10 秒读血量，再 `cancel`；另一次在地下，时间 22400、开日夜循环。
- 预期：判定封闭；`wait` 在作业运行中就返回唤醒原因；3 分钟不掉血；天亮时作业自己结束；`notes/places.md` 有避难处和出去的方法。

### 32. 报告 `upkeep`
- 布置：`give <名字> stone_pickaxe[damage=125]` 后挖几块石头，再挖到它坏；`effect give <名字> hunger 25 120` 且背包没有食物；之后给面包；竞技场 `fight.mjs zombie2 idle 1 wooden_sword 10`。
- 预期：依次看到 "held stone_pickaxe has N of 131 uses left"、"broke: stone_pickaxe"、"food N/20 and nothing to eat"、"ate bread ×N"、"fought zombie ×N, fled N times"。

### 33. 崩溃提示和唤醒计数
- 布置：作业中 `kill -9` main，再启动，`wait`；作业中 RCON `kick`，再启动，`wait`；`stop` 后再启动，`status`。没人 wait 时同一句私聊 3 次。
- 预期："main restarted after a crash (its last record at …); the job … was lost"、"main restarted after it exited with code 1 …"；正常停止后没有提示；私聊一行带 "(×3)"。
