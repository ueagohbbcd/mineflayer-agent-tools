# 试验区

这里的代码是测试和试玩中用到的控制逻辑，**还不是仓库例程**：实机验证还少，接口随时会改。玩家项目可以复制过去用、改。

升级规则：试验区的代码在两次真实试玩中用过、没有导致死亡或控制者卡住，就整理成例程；验证记录留在代码旁边（下面的表）。

每件事只有一种做法：导航用 `walkTo`，采集用 `digNearby`，还手和进食是反射（`reflexes.mjs`，基于 mineflayer-pvp 和 mineflayer-auto-eat）。第二种做法要有实机证据说明它在某种情况下更好才加进来。

这里的名字说清函数做什么，也只说这些（`walkTo`、`craftAndCount`、`fightOrFlee`）；不用一个词的基本名，因为基本名读起来像唯一正式的做法。

这里的函数都自己遵守退出约定：入口和每次 await 之后检查 `signal`，已中止就抛出，不再做游戏动作。只调用它们的任务不需要写退出代码。

| 文件 | 作用 |
| --- | --- |
| `reflexes.mjs` | 反射：`fightOrFlee`（拿最好的武器用 mineflayer-pvp 还手；低于 8 血开始逃，回到 14 血以上或 12 格内没有敌对生物才停，逃的方向在 16 个方向里选能走、不朝 6 格内敌对生物、终点离它们最远的一个，被逼到角落就还手；7 格内的苦力怕只躲不打）、`digHeadFree`（头在方块里就用 mineflayer-tool 换工具挖开，或后退）、`eatWhenHungry`（用 mineflayer-auto-eat 选食物、吃、换回原物品）；带 `check` 的可以用在任务的安全点 |
| `stay-alive.mjs` | `stayAlive`：没有作业时的循环，模板用它做核心的 idle（`createHost(bot, { idle: stayAlive })`）：头在方块里就出来（`digHeadFree`）、被打就还手（`fightOrFlee`）、7 格内有苦力怕就躲（`fightOrFlee`）、在水里按住跳浮在水面、饿了或受伤且饥饿低于 18 时吃（`eatWhenHungry`） |
| `preempt-when-hurt.mjs` | 观察器 `preemptWhenHurt`：被敌对生物打且血量低于 12 时让 `fightOrFlee` 抢占，窒息时让 `digHeadFree` 抢占；之后结束作业 |
| `walk-to.mjs` | `walkTo(bot, ctx, [x, y, z], { range, stallMs, checks, goal })`：用当前寻路设置走到坐标，每 0.5 秒检查一次；到达按 goal 判定核对脚和脚上一格；连续 3 次无路或 `stallMs`（20 秒）不前进时抛错，错误带寻路最后状态。`checks` 默认为空；给了才在每次检查时设安全点（进阶用法）。`goal` 换掉默认的 GoalNear（`digNearby` 用"够得着某个方块"） |
| `craft-and-count.mjs` | `craftAndCount(bot, ctx, name, count, table)`：按物品名合成；配方运行 ceil(count / 每次产出) 次，物品数量至少增加"次数 × 每次产出"才算成功，否则抛错 "crafting <物品>: wanted N, got M …"（依据：试玩里一次要 8 根木棍只到了 4 根）。要工作台的配方没给 `table` 时，用够得着的工作台，没有就用 `placeNear` 放一个 |
| `reflexes.mjs` 里的 `surfaceForAir` | 第四个反射：头在水里、空气 ≤ 10 时 `check` 触发；按住跳往上游，头顶是实心方块就挖开，2 秒不再上升就走向 5 格内的水面；20 秒出不来就抛错。`headInWater` 判断眼睛所在格有没有水 |
| `preempt-when-drowning.mjs` | 观察器 `preemptWhenDrowning`：受到 `drown` 伤害、或每 0.5 秒检查 `surfaceForAir.check` 触发时，请求 `surfaceForAir` 抢占（任务或 idle），之后结束作业 |
| `dig-nearby.mjs` | `digNearby(bot, ctx, names, count, { radius, dig, keep })`：不用 collectblock 采集附近的方块：最近的先挖，走到够得着处（默认只走路，`dig` 时用能挖的设置，但不挖工作台、熔炉、箱子、床和 `keep`），用 mineflayer-tool 换工具，挖，捡掉落物；每次寻路搜索 3 秒、范围半径 + 8，每个方块 30 秒，失败就跳过并在输出里写原因，跳过 5 个就停；缺工具或工具坏了就抛错；挖开后水进来就请求 `surfaceForAir` 抢占 |
| `place-near.mjs` | `placeNear(bot, ctx, item)`：把背包里的方块放在身边够得着、身体不占、下面是完整方块的空格里，从不点会开窗口的方块；没有空格（1 格宽的坑）就先挖开脚边一格墙；在 `notes/places.md` 追加一行。`notePlace(text)` 写那一行，`fillerBlock(bot)` 选一个可以随便用掉的方块（圆石、泥土……） |
| `smelt-items.mjs` | `smeltItems(bot, ctx, input, count, fuel)`：用够得着的熔炉，没有就 `placeNear` 放一个；先取出输出格的东西、退回不同种的输入、同种的输入算进数量，只放背包里有的数量，燃料格空时放够燃料；之后每 10 秒开一次熔炉取输出再关上，输入用完就结束 |
| `equip-armour.mjs` | `equipArmour(bot, ctx)`：四个部位各穿上背包里最好的护甲（按材料），比身上的好才换 |
| `climb-to-surface.mjs` | `climbToSurface(bot, ctx)`：从地下挖台阶到露天处，每一步：安全点、选方向（先选面朝的方向）、挖头顶和下一级台阶的两格、台阶下没地面就放一块、走上去；挖之前查液体和头顶的沙子沙砾，台阶上方落下的沙砾再挖掉，往上都不安全就横走一格。每一步都重新读世界，所以可以从入口重跑 |
| `seal-in.mjs` | `sealIn(bot, ctx)`：先等站稳，用背包里的方块把脚和头两格四周、头顶、脚下的空格都填上，再从脚下做最多 32 格的洪水填充确认封闭；返回怎么出去，并在 `notes/places.md` 记下。作为作业时封好后 `ctx.wake` 告诉模型，然后等到天亮 |

查询 `game/queries/find-blocks.mjs`（最近的 N 个指定方块，带坐标和距离，一行一个）和报告函数 `game/observers/upkeep.mjs`（工具坏了、手里的工具快坏、饿了又没吃的、idle 和反射吃过打过逃过什么）不在试验区，见各自文件开头。

每个新文件都有默认导出，可以直接当作业运行，例如 `node game.mjs run <toolkit>/game/experimental/dig-nearby.mjs iron_ore 5 16 dig`；参数写在文件开头。

## 架构特性对照

这些例程是给游玩模型先读再自己写的代码，所以合起来要用到架构的每个设计特性，每个都用在它真正需要的地方。下表是对照；代码里每个特性用到的那一行有一句注释。

| 特性 | 哪个例程用到，为什么在这里 | 位置 |
| --- | --- | --- |
| 1 任务约定（`ctx.args`、`ctx.log`、返回值、带下一步的错误） | 每个文件的默认导出读 `ctx.args`；`digNearby` 每挖一块、每跳过一块写一行 `ctx.log`，返回 `{ dug, wanted, got, skipped }`，失败时说下一步（"Craft one, then run again"、"Try again with digging movements (dig)"） | `dig-nearby.mjs`：`digNearby`、默认导出 |
| 2 退出规则（自己的 await 之后查信号；工具函数自己会抛） | 各例程在自己的 `await bot.dig`/`equip`/`placeBlock` 之后 `ctx.signal.throwIfAborted()`；调用 `walkTo` 的地方不查（它自己抛）；超过 5 秒的等待用带 `signal` 的 `setTimeout`，否则取消会卡住（实机看到过） | `dig-nearby.mjs`：`digOne`；`smelt-items.mjs`：等待循环；`seal-in.mjs`：默认导出 |
| 3 `ctx.cleanup(fn)` | `smeltItems` 打开的熔炉窗口在任何退出时关掉；`digNearby` 改过的寻路设置在取消的那一刻就恢复（`bot.dig` 还没返回时） | `smelt-items.mjs`：`smeltItems`；`dig-nearby.mjs`：`digNearby` |
| 4 本例程用自己的寻路设置，之后回到只走路 | `digNearby` 按 `dig` 选走路或挖掘设置（挖掘时 `blocksCantBreak` 放进工作台等），`finally` 里 `defaultMovements` | `dig-nearby.mjs`：`digNearby` |
| 5 有界搜索 | `digNearby`：`thinkTimeout` 3 秒、`searchRadius` 半径 + 8、每个方块 30 秒的 `AbortSignal.timeout`（到时停寻路、停挖），失败跳过；Limits 写了原因（collectblock 撑爆内存） | `dig-nearby.mjs`：`digNearby`、`digOne` |
| 6 安全点 `then: 'restart'`，从入口重跑接着做 | `climbToSurface` 每一步 `ctx.safepoint({ surfaceForAir: 'restart', eatWhenHungry: 'restart' })`，每步只读当前位置和周围，所以重跑就是接着爬；实机取消后重跑验证过 | `climb-to-surface.mjs`：`climbToSurface` |
| 7 任务内请求抢占 `ctx.preempt` | `digNearby` 挖开后水漫到头部时自己请求 `surfaceForAir`：反射的 `check` 要等空气降到 10，而任务此刻就知道水进来了（2026-11-10 唯一的死亡就是挖矿时溺水）。`then: 'end'`，因为重跑会再挖 `count` 个。多数例程用不到它：危险通常由观察器或安全点发现 | `dig-nearby.mjs`：`digNearby` |
| 8 `ctx.wake(reason)` | `sealIn` 作为作业封好后叫醒模型（"sealed in …; night ends in about N min"），作业继续等到天亮 | `seal-in.mjs`：默认导出 |
| 9 反射 `{ check, run }` | `surfaceForAir`：`check` 用在 `climbToSurface` 的安全点，也被观察器每 0.5 秒调用；`run` 由抢占启动 | `reflexes.mjs`：`surfaceForAir` |
| 10 观察器从事件请求抢占 | `preemptWhenDrowning`：`drown` 伤害事件和定时检查 → `host.preempt('surfaceForAir')` | `preempt-when-drowning.mjs` |
| 11 报告函数，自己记"上次报告以来" | `upkeepReport` 记下坏掉的工具、吃过打过逃过的次数，每次被调用后清空 | `game/observers/upkeep.mjs`；模板 `main.mjs` 注册 |
| 12 只读查询模块 | `find-blocks.mjs`：读 `ctx.args`，返回几行短文本 | `game/queries/find-blocks.mjs` |
| 13 idle | `stayAlive`：开头注释说明 idle 的形状（像任务一样的函数、循环到信号、直接调用反射的 `run`、返回或抛错之后怎样） | `stay-alive.mjs` |
| 14 给模型留记录 | `placeNear` 和 `sealIn` 把放下的工作台、熔炉、避难处和出去的方法追加到 `notes/places.md` | `place-near.mjs`：`notePlace` |

### 每个例程取自哪个版本

对比了三个玩家（Ash、Birch、Cedar，2026-11-10）各自写的版本，留下在试玩里管用的做法：

- `digNearby`：Cedar 的 `mine.mjs`（不用 collectBlock，走近再 `bot.dig`，捡掉落物；他靠它拿到 14 个粗铁）和 Birch 的 `mine.mjs`（限制 `thinkTimeout`、`searchRadius`，用 `ctx.cleanup` 恢复，跳过失败的方块）；Ash 和 Birch 的 collectBlock 版本加 40 秒超时仍然卡住或撑爆内存，没有用。
- `placeNear`：Ash 的 `getTable`/`placeFrom`（候选格按距离排序，没有空格就挖开一格墙，在 1 格宽隧道里失败后改出来的）；加上 Birch 和 Cedar 被服务器拒绝的两种情况（身体占着目标格、站在水里只找了空气格）和 Ash 点到熔炉的教训。
- `smeltItems`：Ash 的 `smelt.mjs`（容忍熔炉里已有的东西，只放背包有的数量——他因为 `putInput` 要多了失败两次）；三个版本都用 `ctx.cleanup` 关窗口。
- `equipArmour`：三个版本相同（按名字后缀装到四个部位）；加了"比身上的好才换"。
- `climbToSurface`：Ash 的 `surface.mjs` 用能挖能搭的寻路到地表；改成不靠寻路的一级级台阶，因为 Birch 用能搭的寻路时悄悄用掉了 47 块圆石，Cedar 和 Birch 的挖掘寻路在坑里报 noPath。
- `sealIn`：Cedar 的 `bunker.mjs`（填脚和头两层的四周、头顶、脚下，两遍，最后列出仍然开着的格）；"仍然开着"改成有限的洪水填充。Ash 的挖坑封顶版本第一次封口失败。
- `craftAndCount`：三个 `craft.mjs` 都有"附近找工作台，没有就放一个"，收进来时改用 `placeNear`。
- `find-blocks.mjs`：三个 `find.mjs` 几乎相同；名字列表加 `*` 通配（Birch 和 Cedar 用正则）。

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

## 实机记录（2026-11-12）

本地 1.21.1 官方服务器，普通难度，模板 `main.mjs`，测试项目 `play/routines`（`game/template/` 的新副本），MF_USERNAME=Rout。自然地形（种子 20261104）；物品用 RCON `give`。内存是 main 进程的 RSS（`ps -o rss`，每秒一次）。场景和布置见 [../dev/SCENARIOS.md](../dev/SCENARIOS.md) 第六节。每项跑一次，除非另注。

| 场景 | 结果 |
| --- | --- |
| `digNearby` 一棵橡树的树干，只走路，空手（`dig-nearby.mjs '*_log' 6 16`，-505 103 830 附近） | 完成，38.7 秒，6 个原木全部挖到（脚下 1 格到上方 6 格；挖掉下面几格后站进树干的位置够到上面的），结果 `{"dug":6,"wanted":6,"got":{"oak_log":6},"skipped":[]}`；RSS 200 → 201 MB |
| `digNearby` 地下 5–6 格的铁矿，没有镐（`dig-nearby.mjs iron_ore 3 16 dig`，-242 63 559） | 0.1 秒失败："iron_ore at -243 58 549 needs one of stone_pickaxe, iron_pickaxe, diamond_pickaxe, netherite_pickaxe; the inventory has none. Craft one, then run again" |
| 同上，给石镐，只走路 | 54.4 秒失败：5 个矿各 10 秒没有前进（寻路最后状态 noPath）后跳过，每个在 `run` 输出里一行 "skip iron_ore at … : no progress for 10 s …"；错误以 "Try again with digging movements (dig) or walk closer" 结尾 |
| 同上，挖掘设置（`… iron_ore 4 16 dig`） | 完成，71.9 秒，挖到 4 个，`got` 为 raw_iron 4、cobblestone 13、dirt 3（路上挖的）；RSS 205 → 205 MB；之后 `plugins.mjs` 查询 `canDig` false、`allow1by1towers` false（只走路的设置已恢复） |
| 够不到的目标：`fill` 一个 3×3×3 基岩盒，中间绿宝石矿（-230 49 548，约 13 格外），挖掘设置，铁镐 | 4.6 秒失败："skip emerald_ore at -230 49 548: no path to -230 49 548 with the current movements"，然后 "dug none of 1: …"；RSS 207 MB 不变。先只有石镐时 0.2 秒失败，错误列出能挖它的镐 |
| 自己的工作台和熔炉挡在路上：-236 54 545 到 -231 61 553 填满石头，-236 57 549 工作台、-236 58 549 熔炉（朝角色的一面），后面 -233 57 549 钻石矿；角色在西边 2 格的空洞里，挖掘设置 | `dig-nearby.mjs crafting_table 1` 立即失败："digNearby does not dig crafting_table (built or kept blocks)…"。`dig-nearby.mjs diamond_ore 1 8 dig` 12 秒完成，绕开工作台和熔炉从旁边挖过去（`got` cobblestone 8、diamond 1）；RCON `execute if block` 确认工作台、熔炉还在，矿的位置是空气。第一次用铁矿做目标时挖到了附近一个天然铁矿（离得更近），不算，换成钻石矿重跑 |
| `digNearby` 10 个原木，三棵树，只走路，铁斧（`'*_log' 10 24`，-507 103 830） | 完成，51.7 秒，10/10，最高的在脚下 8 格之上（站进挖空的树干）；RSS 209 → 209 MB |
| 远处够不到的目标：40 格外半空中的西瓜（-560 118 835，比地面高约 9 格），挖掘设置，半径 48 | 19.4 秒失败：角色走了约 40 格到它下面，10 秒没有前进（寻路最后状态 timeout）后跳过，"dug none of 1: …"；RSS 最高 219 MB（开始 209） |
| `surfaceForAir` + `preemptWhenDrowning`：作业 `stay.mjs 60` 中 tp 到自然地面里 3×3、7 格深的水井底（-569 102 836），3 次 | 3/3 没死。第 1、3 次：空气 10 时 "[preempt] surfaceForAir preempts (air 10/20, head under water), then the job ends and idle takes over"，约 2 秒后 "surfaceForAir ended: head above water at (-569, 107, 836)"，没掉血，作业以 "ended after surfaceForAir preempted it" 结束，idle 接手。第 2 次井口盖一层石头、有石镐：游到顶后在水里挖开石头，用了 14 秒，受 `drown`×8，最低 6.2 血（在水里又不着地，挖掘慢很多） |
| 出不去时：井口盖基岩、背包清空 | `surfaceForAir` 20 秒后失败 "head still under water after 20 s …, air 0/20"，观察器随即再请求一次，角色溺死（死亡计数 1，`drown`×18）。重生后状态段 "air 20/20"，查询 `oxygenOf` 20，而 Mineflayer 自己的 `bot.oxygenLevel` 是 -1（修复前 `oxygenOf` 在这种情况下读到 -1）。看到一个问题：致命的那下 `drown` 在重生后才送到，观察器在地面上又启动了一次 `surfaceForAir`（"ended: head above water"，无害）；已改成头在水里才请求，未重跑 |
| `digNearby` 挖开眼睛高度的矿，矿后面是水源（石头里 2 格高的小洞，-577 106 835 钻石矿，-576 106 835 水） | 挖掉矿后水流进来，任务自己请求抢占："[preempt] surfaceForAir preempts (water came in after digging at -577 106 835), then the job ends and idle takes over"，9 秒后 "surfaceForAir ended: head above water …, air 20/20"，作业以 "ended after surfaceForAir preempted it" 结束 |
| `placeNear` 平地（`place-near.mjs crafting_table`，恶地 -540 106 830） | 放在脚边相邻一格（-541 106 830）；`notes/places.md` 新建，追加 "- 2026-11-12 03:30 UTC: crafting_table at -541 106 830 (fact, placed by a routine)" |
| `placeNear` 1 格宽的坑底，2 次（RCON 挖出 3 格深和 5 格深的竖井，tp 到井底） | 2/2 完成：四周没有空格，"no free cell; digging terracotta at … to make room"，挖开脚边一格墙，放进熔炉（1.7 秒）和工作台（0.6 秒）；查询确认方块在；井口仍是空气（没有堵住出路） |
| `smeltItems` 平常的熔炉，2 个粗铁 | 完成，20.2 秒，`took` iron_ingot 2；RCON 看到煤放进燃料格、在烧 |
| `smeltItems` 运行中 `cancel`（第一版：两次检查之间等 10 秒） | **卡住**：`cancel` 5 秒后 "task j6-smelt-items will not exit; main needs a restart"，10 秒的等待结束后才退出。等待改成随信号结束（`node:timers/promises` 的 `setTimeout` 带 `signal`） |
| 用 RCON `setblock … furnace{Items:[…]}` 预先放好粗铁和铁锭的熔炉 | 不算：这样放进的输入 `CookTimeTotal` 是 0，原版服务器不会烧它（煤烧完，粗铁不动）。改为用游戏里的操作把东西留在熔炉里（下一行） |
| `smeltItems` 熔炉里留着同种输入：先 `smelt-items.mjs raw_iron 4`，13 秒时 `cancel`，再跑同样的命令 | `cancel` 47 毫秒内回复 "j9-smelt-items cancelled"（等待已能随信号结束）；RCON 看到熔炉里剩 3 个粗铁和 1 个煤。第二次 "smelting 4 raw_iron … (3 were already in)"，只放进 1 个，40.2 秒完成，`took` iron_ingot 4；熔炉清空 |
| `smeltItems` 熔炉里有别的东西：先放沙子烧，取消；之后要烧粗铁，2 次 | 输出格有玻璃：先取出 2 个玻璃，再烧 6 个粗铁，60.1 秒完成，`took` glass 2、iron_ingot 6。输入格有 3 个沙子：取回背包（RCON 数到沙子 3），烧 2 个粗铁，20.2 秒完成；熔炉只剩没烧完的 1 个煤 |
| `smeltItems` 身边没有熔炉（背包有熔炉、木板、1 个粗铁） | 先 `placeNear` 放熔炉（"placed furnace at -521 108 840"，`notes/places.md` 多一行），燃料自动选木板放 1 块，10.8 秒完成 |
| 合成后穿护甲：背包 24 铁锭、4 木板，附近没有工作台；`craft-and-count.mjs crafting_table:1 iron_helmet:1 iron_chestplate:1 iron_leggings:1 iron_boots:1`，再 `equip-armour.mjs` | 合成全部完成；第二项需要工作台时 `craftAndCount` 用 `placeNear` 放下刚合成的工作台（"placed crafting_table at -516 96 845"）。`equipArmour` 穿上四件，结果 `{"head":"iron_helmet","torso":"iron_chestplate","legs":"iron_leggings","feet":"iron_boots"}`；`wait` 状态段 "armor iron_helmet, iron_chestplate, iron_leggings, iron_boots"，RCON `execute if items entity Rout armor.head iron_helmet` 通过 |
| `equipArmour` 已穿较差的护甲：穿着皮靴和金胸甲，背包有钻石靴和皮胸甲 | 只换靴子（"wearing diamond_boots"），金胸甲不换成皮的；RCON 确认脚上钻石靴、身上金胸甲 |
| `climbToSurface` 沙漠地下 20 格（-374 53 338，RCON 挖出 1×2 的空间；上面 7 格起有一层 RCON 放的 7×7 沙砾），石镐、石锹、16 圆石 | 完成，65.9 秒，27 步，升高 20 格（`{"at":[-374,73,365],"steps":27,"climbed":20}`）。阶梯朝南走，没有经过那层沙砾；到 y=73 后头顶还有沙丘的沙子，没有往上挖，而是横着走了 7 格到露天处 |
| `climbToSurface` 中途取消再重跑：-362 51 337（地下约 22 格），上面 y 59–60 有一层 15×15 沙砾；14 秒时 `cancel`，再 `run` 同一个任务 | 取消时角色到了 y 55；重跑从 y 55 接着走（"climbing from" 是当时的位置，不重复已挖的台阶）：头顶第 3 格是沙砾，于是横着走 5 格到沙砾层外再向上，73.9 秒、32 步到露天处（`{"at":[-358,73,369],"steps":32,"climbed":18}`）；两次合计升高 22 格。没有挖到沙砾 |
| `climbToSurface` 台阶上方有沙砾：-340 60 337，面朝东，第一步的上格正上方 4 格沙砾柱（-339 63..66 337），再往东 y 62 一排沙砾 | 完成，104.6 秒，34 步，升高 34 格（山坡）。沙砾落下后又挖掉：背包多了 gravel 4、flint 1，RCON 确认沙砾柱的位置成了空气；角色头上没有落过沙砾，没有窒息伤害 |
| `sealIn` 夜里野外：沙漠平地（`spreadplayers 400 -100`），时间 18000 不走，开自然刷怪，16 圆石，`seal-in.mjs` | "sealed in at 402 95 -105 (2 cells, 10 blocks placed); to leave: dig 403 95 -105 and 403 96 -105"（洪水填充 2 格就停，判定封闭）；随即 `wait` 返回，唤醒原因 "sealed in at 402 95 -105; night ends in about 5 min; the job waits for dawn (cancel to leave earlier)"，作业仍在运行。之后 3 分钟每 10 秒读血量都是 15（封闭前的值），死亡计数不变，结束时 16 格内 10 只亡灵生物；`cancel` 44 毫秒回复 "j1-seal-in cancelled (195.6 s …)"，报告没有受伤段 |
| `sealIn` 第一次地下（RCON 在 -300 50 300 挖的小洞下面是洞穴） | 失败：角色掉进下面的洞穴，`sealIn` 在下落途中就开始，"Server refused to place block at (-299, 48, 300): the block is still air"。改为先等角色站稳（最多 4 秒，站不稳就报错），重跑见下一行 |
| `sealIn` 地下洞穴里，天快亮（时间 22400、日夜循环开，8 块泥土），改动之后 | 完成，30.2 秒：放 2 块泥土，洪水填充 2 格判定封闭；唤醒 "sealed in at -300 46 300; night ends in about 1 min; the job waits for dawn …"，天亮（23000）后作业自己结束，结果带 `"waited":"until dawn"`；`notes/places.md` 追加 "shelter (sealed in, 2 cells) at -300 46 300; to leave: dig -299 46 300 and -299 47 300" |
| 报告 `upkeep`：快坏的镐（`give Rout stone_pickaxe[damage=125]`，耐久 131） | 挖 1 块石头后 `wait` 的报告有一段 "== upkeep ==\nheld stone_pickaxe has 5 of 131 uses left"。再 `dig-nearby.mjs stone 8 5`：挖到第 5 块时 `run` 打印 "the stone_pickaxe broke"，下一块作业失败 "stone at -301 45 301 needs one of wooden_pickaxe, stone_pickaxe, … the inventory has none (the stone_pickaxe broke). Craft one, then run again"；`wait` 报告 "broke: stone_pickaxe; craft another before going on" |
| 报告 `upkeep`：饿着且没有食物（hunger 效果，背包无食物） | "food 0/20 and nothing to eat in the inventory; health stops coming back below 18" |
| 报告 `upkeep`：idle 吃东西（之后给 8 个面包） | 15 秒内 idle 吃了 4 个面包（饥饿 0 → 20），下一份报告 "since the last report: ate bread ×4" |
| 报告 `upkeep`：idle 打和逃（竞技场，`MF_USERNAME=Rout fight.mjs zombie2 idle 1 wooden_sword 10`） | 150 秒没死，两只僵尸还活着（同 2026-11-10 的结果：饥饿降到 9 后不回血，一直躲）；报告 "food 9/20 and nothing to eat in the inventory; …" 和 "since the last report: fought zombie ×5, fled 14 times" |
| 唤醒原因计数：没人 wait 时 RCON 私聊 3 次同样的话、1 次别的话 | `wait` 的唤醒原因两行："[03:59:15] Rcon whispers: are you there (×3)"、"[03:59:15] Rcon whispers: something else"（以前同样的原因只留第一次，不说次数） |
| main 崩溃后重启：`patrol.mjs` 作业中 `kill -9` main，再启动 | `run` 打印 "main disconnected before the job ended (it exited or was restarted)"；新 main 启动后第一次 `wait` 立即返回："main restarted after a crash (its last record at 03:59:22 UTC); the job j3-patrol was lost; …"（这一次的措辞是改顺之前的 "after a crash at 03:59:22 (its last record) UTC"） |
| main 非零退出后重启：`stay.mjs` 作业中 RCON `kick Rout` | main 打印 "disconnected: socketClosed" 后以退出码 1 结束；重启后第一次 `wait`："main restarted after it exited with code 1 at 03:59:47 UTC; the job j1-stay was lost; the old main's output may say why"。之后 `stop` 再启动：`status` 没有待取的报告（正常停止不提示） |
| `fightOrFlee` 的结束措辞（上面 `fight.mjs` 那次） | idle 里被打到 10.5 血时抢占 idle，之后唤醒原因 "fightOrFlee ended: no hostile mob within 12 blocks"（原来是 "nothing hostile nearby"） |
| `node report.mjs review`（这一局 45 分钟，main 启动 10 次） | 与上面逐项对得上：崩溃 1 次（`kill -9`，"no stop recorded after 03:59:22"）、非零退出 1 次（03:59:47，`kick`）；死亡 2 次，与 RCON 的 deathCount 计分 2 相同：03:26:38 `drown`（基岩盖住的水井）、03:38:56 `fall`（布置时 tp 到 y=90 摔死）；反射一节列出 8 次 `surfaceForAir`（其中 "from task" 1 次是 `digNearby` 的抢占）、2 次 `digHeadFree`、1 次 `fightOrFlee`（"ended: no hostile mob within 12 blocks"）；卡住 1 次（j6-smelt-items，即上面修掉的 10 秒等待）。回顾的死亡行写 "controller idle idle"（时间线里控制者记成 "idle idle"），没有改 |
