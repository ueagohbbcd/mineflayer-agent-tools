# 试验区

这里的代码是测试和试玩中用到的控制逻辑，**还不是仓库例程**：实机验证还少，接口随时会改。玩家项目可以复制过去用、改。

升级规则：试验区的代码在两次真实试玩中用过、没有导致死亡或控制者卡住，就整理成例程；验证记录留在代码旁边（下面的表）。

每件事只有一种做法：导航用 `walkTo`，还手和进食是反射（`reflexes.mjs`，基于 mineflayer-pvp 和 mineflayer-auto-eat）。第二种做法要有实机证据说明它在某种情况下更好才加进来。

这里的名字说清函数做什么，也只说这些（`walkTo`、`craftAndCount`、`fightOrFlee`）；不用一个词的基本名，因为基本名读起来像唯一正式的做法。

这里的函数都自己遵守退出约定：入口和每次 await 之后检查 `signal`，已中止就抛出，不再做游戏动作。只调用它们的任务不需要写退出代码。

| 文件 | 作用 |
| --- | --- |
| `reflexes.mjs` | 三个反射：`fightOrFlee`（拿最好的武器用 mineflayer-pvp 还手；低于 8 血开始逃，回到 14 血以上或 12 格内没有敌对生物才停，逃的方向在 16 个方向里选能走、不朝 6 格内敌对生物、终点离它们最远的一个，被逼到角落就还手；7 格内的苦力怕只躲不打）、`digHeadFree`（头在方块里就用 mineflayer-tool 换工具挖开，或后退）、`eatWhenHungry`（用 mineflayer-auto-eat 选食物、吃、换回原物品）；带 `check` 的可以用在任务的安全点 |
| `stay-alive.mjs` | `stayAlive`：没有作业时的循环，模板用它做核心的 idle（`createHost(bot, { idle: stayAlive })`）：头在方块里就出来（`digHeadFree`）、被打就还手（`fightOrFlee`）、7 格内有苦力怕就躲（`fightOrFlee`）、在水里按住跳浮在水面、饿了或受伤且饥饿低于 18 时吃（`eatWhenHungry`） |
| `preempt-when-hurt.mjs` | 观察器 `preemptWhenHurt`：被敌对生物打且血量低于 12 时让 `fightOrFlee` 抢占，窒息时让 `digHeadFree` 抢占；之后结束作业 |
| `walk-to.mjs` | `walkTo(bot, ctx, [x, y, z], { range, stallMs, checks })`：用当前寻路设置走到坐标，每 0.5 秒检查一次；到达按 goal 判定核对脚和脚上一格；连续 3 次无路或 `stallMs`（20 秒）不前进时抛错，错误带寻路最后状态。`checks` 默认为空；给了才在每次检查时设安全点（进阶用法） |
| `craft-and-count.mjs` | `craftAndCount(bot, ctx, name, count, table)`：按物品名合成；配方运行 ceil(count / 每次产出) 次，物品数量至少增加"次数 × 每次产出"才算成功，否则抛错 "crafting <物品>: wanted N, got M …"（依据：试玩里一次要 8 根木棍只到了 4 根） |

只记录、不抢占的危险观察器（TNT、膨胀的苦力怕、飞行物、被盯上）是 [../observers/danger-alerts.mjs](../observers/danger-alerts.mjs)，模板没有接入。

## 实机记录（2026-11-08，本地 1.21.1 官方服务器，普通难度，模板 main）

每项跑一次，除非另注。

| 场景 | 结果 |
| --- | --- |
| `walkTo` 15 格 | 4.5 秒到达；`wait` 随后立即返回，报告有状态、周围、背包 |
| 出生点在方块里时 `walkTo` | 20 秒不前进后抛错（场景问题：tp 到了沙岩里） |
| 寻路中杀掉 `run` 命令 | 作业继续；`cancel` 后角色停下（之后惯性漂移约 0.2 格） |
| 血 11 时刷一只僵尸 | 被打到 8 血时 `fightOrFlee` 抢占，还手 7 次后"nothing hostile nearby"，作业以 "ended after fightOrFlee preempted it" 结束，转 idle。当时手持面包没换剑，之后给 `fightOrFlee` 加了换武器，未再测 |
| 任务里 `safepoint({ eatWhenHungry: 'restart' })` + 饥饿效果 | 饥饿到 14 时任务退出、吃两块面包、任务从入口开始第 2 次尝试，`run` 命令全程没断 |
| 任务中 `/kill` | 作业以死亡结束，没有重启；重生后 idle 才开始；报告有死亡位置和重生位置 |
| 不理退出信号的任务 + `cancel` | 5 秒后标为卡住并唤醒，仍是控制者；12 秒后任务返回，作业记为 "has exited at last"，再唤醒，转 idle |
| 没人 wait 时私聊 | 下一次 `wait` 立即返回，原因是私聊，报告的聊天段有原文；有 wait 时点名也会唤醒 |
| 头部所在格放泥土 | 受到 `in_wall` 伤害，`digHeadFree` 抢占，挖开后作业结束 |
| 水下 7 格（idle） | 氧气低于 15 才按跳时角色在水面和水下来回，没有掉血；改成在水里一直按跳，未再测 |
| 连续 20 次合成（2×2 和工作台混合） | 不处理：2 次都在第 9 次左右开始"count did not change"、"missing ingredients"、`updateSlot` 超时，合成格残留物品。每次合成后清理：2 次全部成功，bot 背包和服务器一致。清理已放进 `lib/crafting-fix.mjs`（`fixCrafting` 包住 `bot.craft`），再测 2 次全部成功 |
| 伤害类型 | 看到 `generic`、`mob_attack`（带来源 zombie）、`in_wall` |

## 接入生态插件后（2026-11-09）

| 场景 | 结果 |
| --- | --- |
| 血 7.8 时两只戴头盔的僵尸，`fightOrFlee` 用 pvp | 换上铁剑，被打到 6 血以下后逃开，"nothing hostile nearby"后交回；两只僵尸都没死，之后 idle 再次还手，最低到 1.8 血。逃跑时机和阈值都要再调 |
| 满血时一只僵尸，idle 用 pvp | 僵尸被杀，没掉血；pvp 跟着目标走了几十格 |
| 饥饿效果 + 任务安全点，`eatWhenHungry` 用 auto-eat | 背包有面包和腐肉，吃了面包，任务从入口开始第 2 次尝试 |
| 头部所在格放泥土，`digHeadFree` 用 tool | 换上铁锹挖开 |
| 捡起铁胸甲（armor-manager） | 自动穿上 |
| collectblock 收集 3 个原木 | 只走路的设置下一个都不挖（它只破坏 movements 允许挖的方块）；任务里换成能挖的设置后收集 3 个，退出后恢复只走路 |
| pvp、collectblock 的寻路设置 | 两个插件每次调用都会把 Pathfinder 换成自己能挖的设置；模板把它们的 `movements` 设为 null 后，打完架仍是只走路 |

骷髅、夜里的 idle、`fightOrFlee` 打不过时的逃跑见下面 2026-11-10 的记录。`preemptWhenHurt` 的 12 血阈值没有和别的阈值对比过。

另见：Mineflayer 的 `bot.oxygenLevel` 会被附近其他实体的空气值覆盖（实测出现 400、393），状态报告和 idle 改用 `oxygenOf(bot)` 读自己的值。

## 实机记录（2026-11-10）

本地 1.21.1 官方服务器，普通难度，模板 `main.mjs`（六个插件），测试项目 MF_USERNAME=Scen。场景和布置见 [../dev/SCENARIOS.md](../dev/SCENARIOS.md)。每项跑一次，除非另注。

| 场景 | 结果 |
| --- | --- |
| 启动 main | 进入游戏，idle 控制；`plugins.mjs` 查询：六个插件都在，`canDig` false、`allow1by1towers` false、无脚手架方块，pvp 和 collectblock 的 `movements` 为 null |
| `run tasks/example.mjs 0 121 -151`（16 格） | 3.6 秒完成，结果 `{"at":[-1,121,-151]}`；随后 `wait` 立即返回，有唤醒原因、最近结束的作业、状态、周围 |
| 同一目录第二次 `node main.mjs` | 打印"main is already running for this project (pid 2888, started …)"，退出码 0 |
| `kill -9` main 后 | 留下 `.game/main.sock`；`status` 打印"main is not running"；再启动 main 删掉旧文件、重新绑定，进入游戏，`status` 正常 |
| `stop` | 1.2 秒内 main 退出（SIGTERM），服务器上 Scen 下线，socket 文件删除 |

战斗（`game/dev/fight.mjs`，竞技场 y=120 石头平台，x -51..29、z -206..-126，玻璃围墙；每轮午夜、关自然刷怪、`kill @e[type=!player]`、满血满饱和（saturation 效果，回血快）、只给铁剑、无护甲；怪在出发点东 12 格。"作业中"= `patrol.mjs` A→B→A 两段约 140 格。血量每约 0.6 秒采样一次，最低值可能漏掉瞬间低点。下面的"开始/最低/结束"是血量，"距离"是结束时离出发点的水平距离）

| 场景 | 结果 |
| --- | --- |
| 骷髅，idle，3 次 | 3/3 杀死骷髅，没死；20/18/20、20/18/20、20/18/20；7.6–8.6 秒；距离 2、0.2、1 格。全程 idle（骷髅走近到 4 格内后 pvp 还手），没有抢占，没有唤醒 |
| 骷髅，作业中（2 段），3 次 | 3/3 作业完成，最低 18，没有抢占；角色走过骷髅身边没停，作业结束后 idle 杀死骷髅；33–34 秒；作业结束后距离 1.5、1.8、5 格 |
| 蜘蛛，idle，3 次 | 3/3 杀死蜘蛛，没死；最低 18；7.5–8.1 秒；距离 4.3、4.3、1.5 格 |
| 蜘蛛，作业中（2 段），3 次 | 3/3 作业完成，没有抢占。2 次蜘蛛 90 秒内没有再靠近（没受伤，蜘蛛活着）；1 次作业后 idle 杀死蜘蛛，最低 18 |
| 两只僵尸，idle，3 次 | 3/3 杀死两只，没死。最低 11、16、17；第 1 次被打到 11 血时 `fightOrFlee` 抢占 idle，打完交回；12.6–19.7 秒；距离 1、9、6.3 格 |
| 两只僵尸，作业中（2 段），3 次 | 3/3 作业先完成（僵尸追不上走路的角色），僵尸追到终点后 idle 还手，3/3 之后 `fightOrFlee` 抢占 idle。2 次杀死两只（最低 9、11，结束 11、12 血）；**1 次死亡**：`fightOrFlee` 在 ≤6 血时转身逃 8 格，回血到 6 以上又回头打，来回几次，逃进竞技场西南角（-50 121 -205）被两只僵尸围死，两只都没死。这一组都没有走到"作业中被抢占"：作业在受伤前就结束了 |

### 逃跑改动前后（`fightOrFlee` 的回血滞后和逃跑方向）

布置同上表（`fight.mjs`），`fight.mjs zombie2 idle 3 wooden_sword 10`：先用 `damage` 扣到 10 血，saturation 效果在第一次采样前回到 12，所以"开始"是 12。

| 场景 | 结果 |
| --- | --- |
| 改动前：两只僵尸，木剑，10 血，idle，3 次 | **2 次死亡**：第 1 次 58 秒时死在竞技场东北角（28 121 -127），最低 0.7，杀死 1 只；第 2 次 29 秒时死在同一个角（最低 1.2；角色立即重生，`fight.mjs` 的 0.5 秒采样没看到死亡，从服务器日志 "Scen was slain by Zombie" 和唤醒原因确认，之后 `fight.mjs` 改用服务器的 deathCount 计分判断死亡）；1 次杀死两只（最低 5.2，结束 7.2，19.7 秒，距离 2 格）。三次都是 idle 还手 → `fightOrFlee` 接手，`fightOrFlee` 在 pvp 和逃跑之间来回切换（采样里 `pvp goal` 和 `goal` 交替十几次） |
| 加回血滞后和可走的逃跑方向后：两只僵尸，木剑，10 血，idle，3 次 | 没有死亡（按唤醒原因核对）。1 次杀死两只（最低 11，结束 13，21 秒，距离 4 格）；2 次 150 秒后仍有僵尸（2 只、1 只），最低 4.8、6.3，结束 6.8、6.3，最远离出发点 84、87 格，结束时 37、53 格。逃跑时一路疾跑，饥饿降到 10，不再自然回血，血到不了 14，于是一直在场内躲着僵尸跑；中途没有转身对打 |
| 加回血滞后和可走的逃跑方向后：两只僵尸，铁剑，满血，idle，3 次 | 3/3 杀死两只，没死；最低 15、11.2、15，结束 20、12.5、20；12.6–22.2 秒；距离 8.4、1、5.3 格。第 2 次被打到 11.2 血时 `fightOrFlee` 抢占 idle，打完交回（改动前同一场景：最低 11、16、17） |
| 加回血滞后和可走的逃跑方向后：两只僵尸，铁剑，满血，作业中（`FIGHT_LEGS=2`），3 次 | 3/3 作业先完成，之后 idle 还手、`fightOrFlee` 抢占 idle。**1 次死亡**（死在西墙边 -48 121 -167，`fightOrFlee` 在 9 血时抢占，5 秒后死亡；采样里逃跑和 pvp 交替 2 次；推测逃的方向经过了僵尸身边，没有直接看到）；1 次 150 秒后剩 1 只僵尸，最低 3、结束 3 血、饥饿 10，一直在躲；1 次杀死两只，最低 8.8，结束 10.8 |
| 逃跑方向再改（不朝 6 格内的敌对生物方向跑）后：两只僵尸，铁剑，满血，作业中（2 段），3 次 | 3/3 作业完成、杀死两只，没死；最低 17、9.3、13，结束 20、9.3、15.3；42–47 秒；作业后离出发点 1.1、1.7、6.2 格。1 次 `fightOrFlee` 抢占 idle |
| 逃跑方向再改后：两只僵尸，木剑，10 血，idle，3 次 | 没有死亡（deathCount 计分确认）。2 次杀死两只（最低 11、7.8，结束 13、9.8，20、26 秒，距离 4.5、22 格）；1 次 150 秒后两只都活着，最低 4.5、结束 6.5，最远 81 格，一直在躲（饥饿下降后不回血） |
| 逃跑方向再改后：两只僵尸，铁剑，满血，idle，3 次 | 3/3 杀死两只，没死；最低 16、10.5、15，结束 20、11.5、17.7；12.6–20.7 秒；距离 3.5、5、5.4 格 |
| 苦力怕，铁剑，满血，idle，改动前，3 次 | 3/3 被炸到 2 血（20 → 2，8.1 秒后结束 6 血），没死；角色一直站着：idle 只在被打过或不满血时还手，苦力怕走近就爆炸。爆炸伤害没有触发抢占，也没有唤醒（`preemptWhenHurt` 只认 `mob_attack`、`arrow` 和查得到的敌对来源，爆炸后苦力怕已经不在） |
| 苦力怕，铁剑，满血，idle，改动后（idle 和 `fightOrFlee` 在 7 格内躲开苦力怕，不打它，被逼到角落才打），3 次 | 3/3 没掉血、没死；苦力怕 150 秒后仍活着，角色在场内来回躲（采样里约 38 次换躲的方向），最远离出发点 81 格，结束时 73–76 格。没有唤醒 |
| 苦力怕，铁剑，满血，作业中（2 段），改动后，3 次 | 3/3 角色走过苦力怕身边，苦力怕在身后约 5 秒时爆炸，最低 18、17.9、17.9，作业没有被打断（爆炸后 `fight.mjs` 停止观察，作业仍在走），离出发点 28 格；没有抢占，没有唤醒 |
| 骷髅，木剑，10 血，idle，1 次 | 杀死骷髅，没掉血（采样 12 → 12，结束 20），9.1 秒，距离 3 格；没有抢占，没有唤醒 |
| 骷髅，木剑，10 血，作业中（2 段），1 次 | 作业完成（26 秒），途中中箭 3 次，受伤报告最低 10 血（0.6 秒采样只看到 13）；作业结束后 idle 杀死骷髅，结束 18 血；没有抢占 |
| 作业中被抢占：一只僵尸放在巡逻路上，铁剑，11 血，关自然回血（`FIGHT_NO_REGEN=1 FIGHT_LEGS=2 fight.mjs zombie patrol 3 iron_sword 11`），3 次 | 2/3 走到"作业中被抢占"：第一下被打到 8 血，`preemptWhenHurt` 请求 `fightOrFlee`，任务 2 秒内退出。第 1 次 `fightOrFlee` 在 8 血还手、杀死僵尸，"nothing hostile nearby"后作业以 "ended after fightOrFlee preempted it" 结束，转 idle，共 10 秒；第 2 次又挨一下到 5 血、转为逃跑，跑出 12 格后"nothing hostile nearby"、作业结束、转 idle，之后 idle 里的 `fightOrFlee` 继续躲（不回血，一直低于 14），150 秒后僵尸仍活着、角色 5 血、离出发点 46 格。第 3 次僵尸没打中，作业完成，之后 idle 杀死僵尸，一直 11 血。没有死亡 |

作业中被抢占时模型 `wait` 读到的报告（上表第 1 次）：

```
Woke because:
  [02:31:01] fightOrFlee preempts (hit by zombie, health 8), then the job ends and idle takes over
  [02:31:07] job j5-patrol ended after fightOrFlee preempted it (hit by zombie, health 8)
Now: no job running; controller: idle
Last job: j5-patrol ended after fightOrFlee preempted it (hit by zombie, health 8) (8.2 s, 1 attempt)
reflex fightOrFlee ended: nothing hostile nearby
position: -34.7 121 -165.5
task output (last 1 line):
  attempt 1, food 20, checks {}
== status ==
health 8/20 food 20/20 air 20/20
night (18000), dawn in about 4.2 min
position -35 121 -166 (overworld)
held iron_sword; armor none
inventory changes: iron_sword +1, wooden_sword -1
== nearby ==
hostile mobs within 24 blocks: none
== damage ==
hurt 2 times since the last report: generic×1, mob_attack (zombie)×1; lowest health 8
```

`run` 命令打印的两行：`[preempt] fightOrFlee preempts (hit by zombie, health 8), then the job ends and idle takes over`、`[preempt] fightOrFlee ended: nothing hostile nearby`。第 2 次的报告相同，另有 "hostile mobs within 24 blocks: zombie×1 (nearest 5 blocks away)"、血 5：作业结束后 idle 里的躲避不再唤醒模型。

### 夜里 idle（`game/dev/night.mjs 400 -100 5`）

沙漠里平坦的沙地（`spreadplayers` 落在 403 95 -103），时间 18000 且不走，开自然刷怪，石剑和 8 个面包，满血，idle 控制 5 分钟；每秒读一次状态和血量，死亡按服务器的 deathCount 计分。

| 场景 | 结果 |
| --- | --- |
| 第 1 次 | 活过 5 分钟；最低 5 血、结束 5 血；最远离出发点 10.5 格；被尸壳打 6 次，第 6 次后 `fightOrFlee` 抢占 idle 9 秒，"nothing hostile nearby"后交回。结束时饥饿 16，背包里 8 个面包一个没吃：`eatWhenHungry` 在饥饿 ≤14 时才吃，而饥饿低于 18 不自然回血，于是一直 5 血 |
| 第 2 次（idle 改为受伤且饥饿低于 18 时也吃） | 活过 5 分钟；最低 14 血、结束 20 血；吃了 1 个面包（8 → 7），捡到 2 块腐肉；最远离出发点 3.7 格；全程 idle，没有抢占，没有唤醒。结束时 24 格内有 14 只亡灵生物和 10 只蜘蛛（RCON 计数） |
| 第 3 次（同第 2 次的代码） | 活过 5 分钟，没受伤（一直 20 血，饥饿 20），没离开出发点；全程 idle，没有唤醒。结束时 24 格内有 18 只亡灵生物和 10 只蜘蛛，但 5 分钟里没有一只打到角色，原因没有查 |

三次最远离出发点 10.5、3.7、0 格，没有出现 pvp 追着目标走远，没有加拴绳。

### 作业生命周期（竞技场，各 1 次，场景编号见 SCENARIOS.md）

| 场景 | 结果 |
| --- | --- |
| 12 杀掉 `run` 进程，作业继续，`cancel` 结束 | 通过。`run` 进程被杀后 `status` 仍是"j1-patrol running"，2 秒内角色从 -27.8 走到 -16.3；`cancel` 回复"j1-patrol cancelled (6.1 s, 1 attempt)"，之后 2.5 秒位置不变、没有寻路目标，控制者 idle；`wait` 立即返回，唤醒原因"job j1-patrol cancelled" |
| 13 抢占请求后立刻取消（第 1 次，无护甲） | 没有走到"取消"：`[preempt] fightOrFlee preempts (hit by zombie, health 8)` 后 0.1 秒内发出 `cancel`，`slow-exit` 照约定 3 秒后才返回，这 3 秒里角色站着挨打，2 秒后死亡（最低 2 血）。`cancel` 等到 3.1 秒后回复"j2-slow-exit ended by death at -50 121 -166"：死亡覆盖了取消，作业不重跑，重生后 idle 控制，报告有死亡和重生位置 |
| 13 抢占请求后立刻取消（第 2 次，全套铁甲，其余同第 1 次） | 通过。`[preempt] fightOrFlee preempts (hit by zombie, health 9.6)` 后立即 `cancel`，3 秒后（`slow-exit` 返回时）回复"j3-slow-exit cancelled"；作业以 "cancelled" 结束，不是 "ended after fightOrFlee preempted it"；控制者从任务直接到 idle，`fightOrFlee` 没有作为反射启动；idle 里随即躲开僵尸（5.5 血，低于 8），6 秒走了 29 格；`wait` 的两条唤醒原因是抢占和"job j3-slow-exit cancelled" |
| 14 `fightOrFlee` 占着作业时取消（11 血、关回血、胸甲和护腿，僵尸在巡逻路上） | 通过。返回段被打到 9.1 血，`fightOrFlee` 抢占；1.5 秒后 `status` 是"controller: reflex fightOrFlee"、"current job: j4-patrol running"，pvp 目标 zombie；`cancel` 70 毫秒后回复"j4-patrol cancelled (22.1 s, 1 attempt)"；之后控制者 idle，idle 继续打僵尸，2 秒后 pvp 目标和寻路目标都为空；`run` 输出的最后是"j4-patrol cancelled"，没有"[preempt] fightOrFlee ended"一行 |
| 15 `fightOrFlee` 打架时提交新作业（布置同 14） | 替换按约定发生：`fightOrFlee` 抢占 j5-patrol（9.1 血）1 秒后提交 `example.mjs -40 121 -150`，j5-patrol 以"replaced by a new job"结束，`fightOrFlee` 退出，j6-example 立即开始。僵尸仍在身边，2 秒后又把角色打到 7.3 血，`fightOrFlee` 抢占 j6-example，"nothing hostile nearby"后 j6 以 "ended after fightOrFlee preempted it" 结束，转 idle。新作业开始了，但没有完成：替换不会顺带处理身边的怪 |
| 16 不理退出信号的任务 + `cancel` | 通过。`cancel` 5 秒后回复"task j7-ignore-cancel will not exit; main needs a restart"；`status` 是"controller: task j7-ignore-cancel (will not exit; main needs a restart)"；唤醒原文带最后一行输出和退出规则："…has not exited 5 s after the exit request (cancelled) and still holds the character; its last log line: waiting 12 s, ignoring the abort. A task must do this: after every await, check ctx.signal.aborted and return if it is true. …"。12.2 秒时任务返回，唤醒"has exited at last"和"job j7-ignore-cancel cancelled"，控制者 idle |
| 17 作业中 `/kill` | 通过。走了 4 秒后 RCON `kill Scen`；`status` 先是"task j8-patrol (exiting)"，0.3 秒后 idle；`run` 最后一行"j8-patrol ended by death at -26 121 -166"，没有重跑；唤醒原因依次是死亡（-26 121 -166）、重生（-7 121 -151）、作业因死亡结束，状态段"died 1 time since the last report: at -26 121 -166; respawned at -7 121 -151" |
| 18 走路时饿了，不带 `checks`（hunger 效果 22 秒、50 级，8 个面包，4 段） | 通过。作业没有重跑，一直走完（50 秒，尝试 1 次），饥饿 20 → 9 → 7 → 6；作业结束后 idle 吃面包，4 秒后饥饿 16、剩 6 个面包 |
| 18 走路时饿了，`patrol.mjs … 4 eat`（`checks: { eatWhenHungry: 'restart' }`，布置同上） | 通过。第 2 段途中"[preempt] eatWhenHungry preempts (food 14), then the task runs again from the top"，"eatWhenHungry ended: ate, food 14 → 17, 17 → 20"，"[restart] attempt 2, running the task from the top"，第 2 次尝试从第 1 段重新走完 4 段；`run` 一直跟着到"j10-patrol done (65 s, 2 attempts)"，结果 `attempt: 2`；吃了 2 个面包 |
| 19 头在方块里（走路途中 `execute at Scen run setblock ~ ~1 ~ dirt`，背包有铁锹） | 通过。受到 1 次 `in_wall` 伤害（19 血），"[preempt] digHeadFree preempts (suffocating, head inside a block)"，约 2 秒后"digHeadFree ended: head free"，作业以"ended after digHeadFree preempted it"结束；查询头部所在格是 air，手持 iron_shovel |
| 20 打架和收集之后仍然只走路 | 通过。`fight.mjs zombie idle 1`（idle 用 pvp 杀死僵尸，最低 17）之后，和 `collect-logs.mjs 3`（任务内能挖，5.3 秒收集 3 个原木，结果 `canDigDuringTask: true`）之后，`plugins.mjs` 查询都是 `canDig` false、`allow1by1towers` false、无脚手架方块，pvp 和 collectblock 的 `movements` 为 null |
| 21 连续 20 次合成（`craft-and-count.mjs`，工作台在身边，16 原木、4 煤） | 通过。5.5 秒完成，20 步全部数量增加，`failed: 0`，合成格和光标为空；bot 背包和 RCON `clear Scen <物品> 0` 的 10 种物品数量逐项相同（原木 7、木板 12、木棍 11、煤 2、火把 8、箱子、木镐、木剑、按钮、压力板各 1） |
| 22 没人 wait 时私聊（RCON `tell Scen 你好，在吗`） | 通过。之后 `status` 显示"a report is waiting"；`wait` 60 毫秒内返回，唤醒原因"Rcon whispers: 你好，在吗"，聊天段有原文 |
| 23 main 被 `busy-forever.mjs` 卡住时 `stop` | 通过。提交 4 秒后 `status` 等 5 秒回复"main did not reply within 5 s (its main thread may be blocked; node game.mjs stop, then start main again)"，退出码 1；`.game/blocked.json` 有 `{"seconds":5,"pid":8756}`；`stop` 打印"main (pid 8756) did not exit within 5 s; killed it"，8 秒内返回，服务器上没有玩家在线；`run` 打印"main disconnected before the job ended (it exited or was restarted)"。留下 `main.sock` 和 `blocked.json`；再启动 main 正常进入游戏，`blocked.json` 被删掉 |
| 24 时间线和回顾（2026-11-10，1 次，项目 `play/journal`，MF_USERNAME=Journal，6 分钟） | 通过。回顾：main 启动 3 次（服务器日志 joined 3 次），崩溃 1 次（`kill -9`，日志 06:56:35 lost connection，之前没有 `main_stop`），`stop` 那次 `main_stop` 退出码 0；死亡 2 次，06:56:14 和 06:58:03，与日志的两条 "Journal was killed" 和 `jDeaths` 2 相同，致命伤害都是 `generic_kill`，第二次死前一行"hurt generic×2, health 17→15.5"对应两次 RCON `damage 3`，致命一击记为血 0；作业 10 个：完成 4、失败 1（`broken.mjs`）、取消 1、被抢占 1、死亡 2、main 退出 1，与各次 `run` 的最后一行逐个相同；第一个作业在 main 启动后 5.8 秒开始；`fightOrFlee` 抢占（hit by zombie, health 8）→ "ended: nothing hostile nearby"，作业被抢占后结束，与 `fight-results.jsonl` 的 `jobEnd` 相同；mob_attack 2 次（血 11→8→5，与 fight 的 `healthStart` 11、`healthMin` 5 一致），generic 3 次（fight 的 1 次加 2 次 RCON）；`wait` 送达 9 次，等于调用次数（含 `fight.mjs` 的 1 次）；作业结束到下一次报告最长 142 秒（`fight.mjs` 观察 150 秒后才 `wait`）；`records/tasks/` 有 `hop` 两份（改过一行）、其余各一份。回顾正文 1841 字（两次死亡的前 60 秒占约一半）。没有覆盖：卡住的控制者、怪物打死角色时的致命来源、超过 3 分钟的作业 |

## 实机记录（2026-11-11）

本地 1.21.1 官方服务器，普通难度，模板 `main.mjs`（六个插件），测试项目 `play/names`（`game/template/` 的新副本），MF_USERNAME=Names。所有给模型看的输出是英文。场景和布置见 [../dev/SCENARIOS.md](../dev/SCENARIOS.md)。每项跑一次，除非另注。

| 场景 | 结果 |
| --- | --- |
| 1 启动 main | `main.log` 有 "joined the game: Names at (-21.5, 121, -169.5)"；`status` 是 "controller: idle"；`plugins.mjs` 查询：六个插件都在，`canDig` false、`allow1by1towers` false、无脚手架方块，pvp 和 collectblock 的 `movements` 为 null |
| 2 `run tasks/example.mjs 0 121 -151`（约 49 格）+ `wait` | 10.2 秒完成，结果 `{"at":[-1,121,-151]}`；先在等的 `wait` 随即返回，报告原文见下 |
| 12 杀掉 `run` 进程，作业继续，`cancel` 结束 | 通过。`run` 进程被杀后 `status` 是 "controller: task j2-patrol"、"current job: j2-patrol running (3.5 s, 1 attempt)"，2 秒内角色从 -28 走到 -16.5；`cancel` 打印 "j2-patrol cancelled (9.1 s, 1 attempt)"，之后位置不变、没有寻路目标，控制者 idle；`status` 多一行 "a report is waiting: node game.mjs wait returns at once"，`wait` 立即返回，唤醒原因 "job j2-patrol cancelled" |
| 10 作业中被抢占（`FIGHT_NO_REGEN=1 FIGHT_LEGS=2 fight.mjs zombie patrol 2 iron_sword 11`），2 次 | 2/2 走到"作业中被抢占"，没有死亡。`run` 打印 "[preempt] fightOrFlee preempts (hit by zombie, health 8), then the job ends and idle takes over" 和 "[preempt] fightOrFlee ended: nothing hostile nearby"，作业以 "ended after fightOrFlee preempted it (hit by zombie, health 8)" 结束，控制者依次 task、reflex:fightOrFlee、idle。第 1 次 `fightOrFlee` 在 8 血还手、杀死僵尸，10 秒，离出发点 17 格；第 2 次又挨一下到 5 血、转为逃跑，12 格内没有僵尸后交回（报告里 "zombie×1 (nearest 15 blocks away)"），之后 idle 一直躲（关了回血，血不回到 14），150 秒后僵尸仍活着、角色 5 血、最远离出发点 79 格 |
| 6 两只僵尸，idle（`fight.mjs zombie2 idle 1`，铁剑满血） | 杀死两只，没死；最低 13、结束 17.3；14 秒；离出发点 4.2 格；全程 idle（pvp 和躲开交替 3 次），没有抢占，没有唤醒 |
| 8 苦力怕，idle（`fight.mjs creeper idle 1`，铁剑满血） | 没掉血、没死（最低 20）；苦力怕 150 秒后仍活着，角色在场内来回躲，最远离出发点 81 格，结束时 75.5 格；没有 pvp，没有唤醒 |
| 18 走路时饿了，`patrol.mjs … 4 eat`（`checks: { eatWhenHungry: 'restart' }`，hunger 效果 60 秒、50 级，8 个面包） | 通过。饥饿效果持续期间 4 次 "[preempt] eatWhenHungry preempts (food 14), then the task runs again from the top"，每次 "[preempt] eatWhenHungry ended: ate, food 14 → 17, 17 → 20" 和 "[restart] attempt N, running the task from the top"；`run` 一直跟着到 "j5-patrol done (93.9 s, 5 attempts)"，结果 `attempt: 5`；8 个面包吃完。`wait` 的唤醒原因里同样文字的抢占只列一次（第一次的时间） |
| 19 头在方块里（走路途中 `execute at Names run setblock ~ ~1 ~ dirt`，背包有铁锹） | 通过。受到 1 次 `in_wall` 伤害（19.7 血），"[preempt] digHeadFree preempts (suffocating, head inside a block), then the job ends and idle takes over"，约 1 秒后 "[preempt] digHeadFree ended: head free"，作业以 "ended after digHeadFree preempted it (suffocating, head inside a block)" 结束；查询头部所在格是 air，手持 iron_shovel；报告受伤段 "hurt 1 time since the last report: in_wall×1; lowest health 19" |
| 17 作业中 `/kill`，2 次 | 通过。走了 4 秒后 RCON `kill Names`；`status` 先是 "controller: task j1-patrol (exiting)"，0.5 秒后 idle；`run` 最后一行 "j1-patrol ended by death at -26 121 -166 (4.2 s, 1 attempt)"，没有重跑；唤醒原因依次 "died at -26 121 -166"、"respawned at -15 121 -153"、"job j1-patrol ended by death at -26 121 -166"；状态段 "died 1 time since the last report: at -26 121 -166; respawned at -15 121 -153 (dropped items vanish after 5 minutes)"，受伤段 "generic_kill×1; lowest health 0"；死亡计数加 1。第 1 次的结束措辞带两层括号（"…ended by death (-26 121 -166) (4.1 s, 1 attempt)"），改成 "at" 后重启 main 跑第 2 次，上面是第 2 次的原文 |
| 16 不理退出信号的任务 + `cancel` | 通过。`cancel` 5 秒后打印 "task j2-ignore-cancel will not exit; main needs a restart"，退出码 1；`status` 是 "controller: task j2-ignore-cancel (will not exit; main needs a restart)"；`run` 和唤醒原因里的卡住消息原文："task j2-ignore-cancel has not exited 5 s after the exit request (cancelled) and still holds the character; its last log line: waiting 12 s, ignoring the abort. A task must do this: after every await, check ctx.signal.aborted and return if it is true. To recover now, restart main: node game.mjs stop, then start main again."。12 秒时任务返回，唤醒 "task j2-ignore-cancel has exited at last" 和 "job j2-ignore-cancel cancelled"，`run` 最后一行 "j2-ignore-cancel cancelled (12 s, 1 attempt)"，控制者 idle |
| 21 连续 20 次合成（`craft-and-count.mjs`，工作台在身边，16 原木、4 煤） | 通过。5.2 秒完成，20 步全部数量增加，`failed: 0`，合成格和光标为空；bot 背包和 RCON `clear Names <物品> 0` 的 10 种物品数量逐项相同（原木 7、木板 12、木棍 11、煤 2、火把 8、箱子、木镐、木剑、按钮、压力板各 1） |
| 21 满足不了的请求：2 块木板，`run tasks/craft-sticks.mjs 8`，2 次 | 2/2 作业失败，没有当成功：第 2 次 `run` 最后一行 "j1-craft-sticks failed: crafting stick: wanted 8, got 4 (0 → 4); the craft failed: missing ingredient (0.4 s, 1 attempt)"，`wait` 的唤醒原因同样文字，状态段 "inventory: stick 4"；RCON 数到 4 根木棍。第 1 次的错误里合成本身的消息带 "Error: " 前缀，去掉后重启 main 跑第 2 次。同样 2 块木板要 4 根时完成，结果 `{"item":"stick","wanted":4,"before":4,"after":8}` |
| 24 `node report.mjs review`（这一局：12 分钟、main 启动 3 次） | 数字与上面各场景逐个对得上：启动 3 次（两次 `stop` 后重启，没有崩溃）；死亡 2 次，与 RCON 的 deathCount 计分 2 相同，都是 `generic_kill`（两次 `/kill`）；作业 13 个，完成 4、失败 2（两次满足不了的合成）、取消 2（场景 12、16）、被抢占 3（两次 fightOrFlee、一次 digHeadFree）、死亡 2；卡住 1 次（j2-ignore-cancel，6 秒后退出）；抢占 7 次（eatWhenHungry 4 次来自安全点）。原文见下 |

`wait` 的报告（场景 2，原文）：

```
Woke because:
  [04:09:47] job j1-example done
Now: no job running; controller: none
Last job: j1-example done (10.2 s, 1 attempt)
result: {"at":[-1,121,-151]}
position: -0.6 121 -150.7
task output (last 1 line):
  from (-47, 121, -166) to 0 121 -151
== status ==
health 20/20 food 20/20 air 20/20
night (18000), dawn in about 4.2 min
position -1 121 -151 (overworld)
held nothing; armor none
inventory: empty
== nearby ==
hostile mobs within 24 blocks: none
```

"controller: none" 是因为报告在作业刚结束、idle 还没开始的那一刻算出。

`node report.mjs review` 的输出（原文；死亡前的行里第一次 `/kill` 的作业结束措辞是改成 "at" 之前写进时间线的）：

```
== Review 04:08:45–04:20:57 (12 min, times in UTC) ==
1. Overview: main started 3 times, no crashes, the last start is still running or crashed; died 2 times
2. Deaths:
  04:19:01 at -26 121 -166, generic_kill; job j7-patrol, controller task j7-patrol
    …8 earlier lines
    04:18:43 task j6-patrol exited (preempt: digHeadFree)
    04:18:43 reflex digHeadFree started
    04:18:44 reflex digHeadFree ended: head free
    04:18:44 job j6-patrol ended after digHeadFree preempted it (suffocating, head inside a block) (5.7 s, 1 attempt)
    04:18:44 state: health 19.7 food 20 at -25 121 -166 held iron_shovel inventory iron_shovel:1
    04:18:44 wait got the report (799 characters)
    04:18:57 submitted j7-patrol (patrol.mjs -46 121 -166 24 121 -166 6, version a0804e2c)
    04:18:57 state: health 20 food 19 at -47 121 -166 held nothing
  04:19:43 at -26 121 -166, generic_kill; job j1-patrol, controller task j1-patrol
    …12 earlier lines
    04:19:01 task j7-patrol exited (death)
    04:19:01 job j7-patrol ended by death (-26 121 -166) (4.1 s, 1 attempt)
    04:19:01 state: health 20 food 20 at -14 121 -157 held nothing
    04:19:02 wait got the report (732 characters)
    04:19:19 main stopped (exit code 0)
    04:19:20 main started (pid 6132, toolkit ec7087ae51)
    04:19:39 submitted j1-patrol (patrol.mjs -46 121 -166 24 121 -166 6, version a0804e2c)
    04:19:39 state: health 20 food 20 at -47 121 -166 held nothing
3. Jobs: 13 (done 4, failed 2, cancelled 2, preempted 3, died 2)
  first job started: 51.7 s after main first started
  first task of your own: j2-patrol (patrol.mjs), first run cancelled
  failed on the first run:
    04:20:38 j4-craft-sticks: crafting stick: wanted 8, got 4 (0 → 4); the craft failed: Error: missing ingredient
  longer than 3 minutes: none
  stuck: 04:20:04 j2-ignore-cancel (cancelled), exited 04:20:10
4. Controller time: task 134 s (18%), reflex 28 s (4%), idle 565 s (77%), no controller 4 s (1%: dead, main not running, handovers)
5. Reflexes:
  04:10:39 fightOrFlee (hit by zombie, health 8, from observer) → ended: nothing hostile nearby; job j3-patrol ended after fightOrFlee preempted it (hit by zombie, health 8)
  04:10:54 fightOrFlee (hit by zombie, health 8, from observer) → ended: nothing hostile nearby; job j4-patrol ended after fightOrFlee preempted it (hit by zombie, health 8)
  04:16:52 eatWhenHungry (food 14, from safepoint) → ended: ate, food 14 → 17, 17 → 20; job j5-patrol done
  04:17:06 eatWhenHungry (food 14, from safepoint) → ended: ate, food 14 → 17, 17 → 20; job j5-patrol done
  04:17:21 eatWhenHungry (food 14, from safepoint) → ended: ate, food 14 → 17, 17 → 20; job j5-patrol done
  04:17:36 eatWhenHungry (food 14, from safepoint) → ended: ate, food 14 → 17, 17 → 20; job j5-patrol done
  04:18:43 digHeadFree (suffocating, head inside a block, from observer) → ended: head free; job j6-patrol ended after digHeadFree preempted it (suffocating, head inside a block)
6. Reports: wait got 10 reports; longest from a job end to the next report: 141 s (j4-patrol)
7. Damage: mob_attack 8 (zombie 8); generic 2; generic_kill 2; in_wall 1
```

这些场景里模型能看到的每一行（`run`、`wait`、`cancel`、`status`、`stop` 的输出，`main.log`，`report.mjs`）都是英文。读下来不顺的三处已改：`status` 把 idle 打成 "idle idle"；死亡结束带两层括号；合成失败消息里重复的 "Error: "。没有跑的：场景 3–5、7、9、11、13–15、20、22、23（这次只覆盖上面列出的场景）。
