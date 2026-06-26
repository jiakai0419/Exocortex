# Exocortex Operations

这份文档回答一个问题：

```text
我每天怎么知道衍我同步系统是不是正常？
```

当前系统仍是 terminal-first。日常入口必须极简，诊断入口可以更完整，但不应该污染日常心智。

## Daily Commands

日常只需要记住三个命令：

```bash
npm run help
```

查看核心命令入口。

```bash
node scripts/messages.mjs --limit 20
```

查看最近同步到本地的消息。

```bash
node scripts/lark-im-service.mjs status
```

查看后台同步服务是否在运行，以及当前同步状态。

完整命令目录只在需要时查看：

```bash
npm run help -- --all
```

## Status Model

`lark-im-service status` 的主状态分成四层，避免把进程、同步、实时活动和远端对照混在一起。

### Service

后台是否会继续自动同步。

`LaunchAgent` 是 macOS 后台服务管理器；`worker` 是真正执行同步的 Node 进程。

```text
RUNNING  LaunchAgent 已加载，worker 进程活着。
STOPPED  LaunchAgent 未加载，或已加载但 worker 进程没起来。
```

主状态只区分 `RUNNING / STOPPED`。细节里会继续展示 LaunchAgent loaded、PID 和 last exit。

### Health

当前同步事实是否可信。

```text
OK           已知范围内同步正常。
CATCHING UP  正在追赶，还不能说完整。
PROBLEM      当前有需要处理的问题。
```

`OK_WITH_HISTORY` 只保留为内部诊断事实，不作为 `lark-im-service status` 的主健康状态。历史失败会保留在 `sync_runs`，但只要当前 cursor、worker 和数据质量健康，主状态仍是 `OK`。

### Activity

worker 此刻是否正在执行同步 step。

```text
IDLE     当前没有同步 step 在跑。
SYNCING  当前正在执行同步 step。
```

`SYNCING` 通常是正常活动，不等于故障。

### Freshness

最近远端 live probe 是否确认热消息已经进入本地。

```text
VERIFIED  最近 live probe 确认没有缺失。
BEHIND    live probe 发现远端热消息还没全部入库。
UNKNOWN   没有可用的缓存 live probe 结果。
```

`lark-im-service status` 不会默认联网跑 live probe。它只读取本地缓存：

```text
logs/lark-im/live-probe.json
```

这个缓存由 `doctor --live` 写入，只保存脱敏摘要：检查时间、状态、缺失数量、lag 和原因。不保存消息 ID、人名、群名、链接或正文。

需要真实远端对照时，手动运行：

```bash
node scripts/doctor.mjs --live
```

运行成功后，`status` 会显示类似：

```text
Freshness  VERIFIED checked 12m ago, missing 0, lag 0s
```

如果 `doctor --live` 显示 `UNAVAILABLE / keychain_unavailable`，说明当前 shell 读不到 keychain，不等于后台同步失败。

### Last 24h

`lark-im-service status` 还会展示过去 24 小时的运行证据。这一层不新增健康状态，只帮助判断后台 worker 是否稳定地连续运行过。

```text
Cycles                       过去 24 小时内 worker cycle 的成功/失败/总数。
Last success                 最近一次成功 cycle，按 cycle 序号和距现在多久展示。
Longest between successes    过去 24 小时内，相邻两次成功 worker cycle 之间的最长间隔；如果窗口开始到第一次成功、或最后一次成功到现在更长，也计入。
Failures                     过去 24 小时内失败 cycle 数，以及失败 step 的聚合计数。
```

`Longest between successes` 衡量的是“成功之间的最大断档”，不是“这段时间完全没有发生同步”。例如成功时间是 `10:00, 10:01, 10:02, 10:43, 10:44`，中间的最大断档是 `10:02 -> 10:43`，显示为 `41m`。

## Initial Catch-Up Done

第一阶段同步基线完成，需要满足：

```text
received_without_cursor = 0
discovery.has_more = false
doctor 不再显示 CATCHING UP
```

可以用：

```bash
node scripts/doctor.mjs
```

或者查看机器可读状态：

```bash
node scripts/sync-status.mjs --format json
```

## Restart After Downtime

同步器必须假设自己可能很久没有正常运行。重启后的目标不是“从现在开始同步”，而是：

```text
从每个 Scope 上次持久化 Cursor 继续追赶到当前稳定边界
```

正常恢复路径：

1. `sent_by_me` 从自己的 Cursor 继续拉取我在停摆期间发出的消息。
2. 已知 `received.chat.*` 从各自 Cursor 继续拉取停摆期间收到的消息。
3. `discover-hot` 继续扫描最近活跃会话，发现新的活跃非免打扰会话。
4. 未完成的 full discovery snapshot 用持久化 `page_token` 继续扫后续页。

重启后短时间出现 `SYNCING` 或 `CATCHING UP` 是正常的。需要重点看：

```text
received_without_cursor 是否下降
discovery.has_more 是否最终变成 false
locks 是否长期不释放
最近失败是否还在重复出现
```

完成初始 catch-up 后，系统会通过独立的 periodic full reconcile 机制，定期完整盘点非免打扰会话集合。这个机制使用独立 Scope，不应该把已完成初始同步的系统长期显示为 `CATCHING UP`。

发现通道当前分三层：

```text
initial full discovery -> 建立第一份完整非免打扰会话集合
hot discovery          -> 每轮扫描最近活跃会话，尽快发现热会话变化
periodic reconcile     -> 定期完整复核会话集合，处理冷门会话和免打扰变化
```

它们分别使用独立 Scope。`hot discovery` 正常运行不应该覆盖 initial full discovery 的完成状态。

## Safe Runtime Maintenance

当前 LaunchAgent 直接运行工作区里的脚本和 `dist` 文件。修改这些 runtime 路径时，如果 worker 正好在中间态 import 文件，可能出现一次短暂失败。失败不会推进错误 Cursor，但会污染最近 worker 日志，也会让维护过程更难判断。

因此，凡是改这些路径，先暂停 worker：

```text
scripts/
src/
dist/
package.json
tsconfig*.json
migrations/
```

推荐维护流程：

```bash
node scripts/lark-im-service.mjs stop
```

确认服务真的卸载：

```bash
node scripts/lark-im-service.mjs status
```

预期 `LaunchAgent / Loaded` 显示 `NOT LOADED`。如果 `stop` 报 `Operation not permitted`，说明当前 shell 没有权限卸载 LaunchAgent；不要继续改 runtime 路径，先切到有权限的普通终端或授权当前操作。

然后修改代码并跑检查：

```bash
npm run typecheck
npm run check
npm test
npm run build:check
```

检查通过后重新启动并等待一个新的完整成功 cycle：

```bash
node scripts/lark-im-service.mjs start
node scripts/lark-im-service.mjs wait-ok
```

最后复查：

```bash
node scripts/doctor.mjs
node scripts/lark-im-service.mjs status
```

如果只修改文档、测试或不会被 worker import 的旁路工具，可以不暂停 worker。但一旦不确定，就按上面的维护流程处理。

### Maintenance Check Command

为了避免每次维护后靠人记住一串验收命令，项目提供一个非日常维护入口：

```bash
node scripts/maintenance-check.mjs
```

它不会进入默认三命令，只出现在完整命令目录：

```bash
npm run help -- --all
```

默认流程：

```text
git status
npm run check
npm run build:check
npm run typecheck
npm test
node scripts/lark-im-service.mjs restart
node scripts/lark-im-service.mjs wait-ok
node scripts/doctor.mjs
node scripts/lark-im-service.mjs status
```

`git status` 只提示工作区是否干净，不作为失败；本地检查、服务重启、`wait-ok`、`doctor` 和最终 `status` 是验收步骤。前置必需步骤失败后，后续步骤会跳过，避免在代码没通过检查时重启服务。

需要真实远端对照时加：

```bash
node scripts/maintenance-check.mjs --live
```

`--live` 会额外运行 `node scripts/doctor.mjs --live`，需要当前 shell 能访问 `lark-cli` auth/keychain。只想跑检查和诊断、不重启后台服务时：

```bash
node scripts/maintenance-check.mjs --no-restart
```

`maintenance-check --live` 内部使用 JSON 形式读取 live doctor 结果，只保留 public-safe 的结构化摘要，例如：

```text
overall
live_status
live_reason
live_missing_count
live_lag_ms
live_exit_status
```

它不会把完整 live probe JSON、消息样本、群名、人名、链接、原始 stderr 或本地数据库路径写进失败摘要。

如果 `doctor` 或 `doctor --live` 失败，`maintenance-check` 仍会继续运行最后的：

```bash
node scripts/lark-im-service.mjs status
```

这样可以区分“后台同步服务已经坏了”和“诊断/live probe 本身失败”。本命令目前不对 live probe 自动重试；如果失败，需要先看结构化原因，再决定是否重跑或修复。

`maintenance-check` 是验收命令，不会自动修改本地消息库。若它因为 data quality 失败，先显式运行对应 maintenance repair，例如：

```bash
node scripts/lark-im-enrich-scopes.mjs --limit 100
node scripts/lark-im-enrich-records.mjs --limit 3000 --probe-apps
```

然后重新运行：

```bash
node scripts/maintenance-check.mjs --live
```

这样可以把“验收失败”和“修复动作”分开，避免后台验收命令悄悄写入私有运行数据。

## Public-Safe Command Output

这个仓库按 public 项目维护，但本地 runtime 数据是私有记忆。因此 terminal 输出分两类：

```text
product output      为本机使用者展示真实消息，例如 messages。
diagnostic output   为维护、验收、排障展示系统状态。
```

`node scripts/messages.mjs --limit 20` 是产品阅读命令，会显示本地消息内容、群名和人员名。它的输出默认不适合复制到公开 issue、文档或 CI 日志。

维护和诊断命令默认应该 public-safe，只展示状态、计数、时间、脱敏原因和必要摘要，不展示真实 chat id、人名、群名、应用名、链接或消息正文。当前这类命令包括：

```bash
node scripts/doctor.mjs
node scripts/doctor.mjs --live
node scripts/lark-im-service.mjs status
node scripts/lark-im-quality.mjs
node scripts/lark-im-lag-check.mjs
node scripts/lark-im-enrich-records.mjs
node scripts/lark-im-enrich-scopes.mjs
node scripts/maintenance-check.mjs
```

少数命令支持显式打开本地明细：

```bash
node scripts/lark-im-lag-check.mjs --unsafe-details
node scripts/lark-im-enrich-records.mjs --unsafe-details
```

`--unsafe-details` 的含义是：输出可能包含真实本地 ID、群名、人名、应用名、消息片段或远端错误细节，只能用于本机临时排障，不要复制进公开仓库、CI artifact 或聊天记录。

## SQLite Private Durability

本地 SQLite 是当前衍我的私有记忆库。同步链路健康之后，需要定期确认它本身没有损坏，并且能生成可验证的本地备份。

这不是日常三命令，也不进入默认 help。需要时从完整目录查看：

```bash
npm run help -- --all
```

当前维护入口：

```bash
node scripts/sqlite-maintenance.mjs check
node scripts/sqlite-maintenance.mjs backup
node scripts/sqlite-maintenance.mjs verify --latest
```

`check` 会检查：

```text
PRAGMA quick_check
PRAGMA foreign_key_check
关键表是否存在
关键表聚合计数
```

`backup` 使用 SQLite 自身的一致性备份机制生成本地私有备份，而不是直接复制正在使用的数据库文件。默认位置：

```text
backups/private/
```

该目录必须保持 git ignored。备份里包含完整个人消息库，只能留在本机私有环境。

`verify --latest` 会打开最新备份，重新跑 integrity check，并和当前数据库比较关键表计数。输出只包含状态、相对路径、计数和校验结果，不展示消息内容、人名、群名、链接或 raw payload。

## When Something Looks Wrong

先看总状态：

```bash
node scripts/doctor.mjs
```

如果想对比远端热消息：

```bash
node scripts/doctor.mjs --live
```

如果 `--live` 显示 `UNAVAILABLE / keychain_unavailable`，说明当前 shell 读不到 keychain。它不是同步系统故障。需要真实 live 验证时，在能访问 keychain 的普通终端环境里运行同一个命令。

`doctor --live` / `lark-im-lag-check` 的真实验收使用本机飞书数据，但仓库里的自动化测试只使用 anonymized shape fixtures。它们保留飞书响应字段形状，不保留真实 ID、人名、群名、链接或消息正文。

### Unsupported Chat Scopes

Received chat scope 可能进入 unsupported 状态。它表示同步器已经正确识别到该会话不能继续通过当前 lark-cli 身份同步，后续会暂停这个 scope，但本地已同步的 records 会保留。

当前已知原因：

- `bot_user_out_of_chat`：lark-cli 返回 `230002` / `Bot/User can NOT be out of the chat.`。同步器不推断用户是退群、被移出，还是切换身份；只按 lark-cli 的实际返回记录。
- `restricted_mode`：飞书返回保密模式/不允许复制转发一类错误。

这些 scope 不应该让 worker 每轮失败。它们会出现在 `node scripts/lark-im-service.mjs status` 和 `node scripts/lark-im-quality.mjs` 的 unsupported reasons 中，用于诊断。

看后台服务：

```bash
node scripts/lark-im-service.mjs status
```

`status` 会同时展示三层信息：

```text
LaunchAgent -> 后台服务是否被 macOS 托管、PID、退出码
Sync        -> 本地同步状态、records、scopes、discovery/reconcile
Worker      -> 最近完整 cycle、最近 step、是否正在跑、最近失败、日志路径
```

### Data Quality

Sender name quality 分三类：

- actionable sender gaps：用户 sender 缺名，或应用 sender 还没有被 resolver 判定为无法安全解析。它们会让 `doctor` 进入 `NEEDS ATTENTION`。
- system senderless messages：飞书系统消息天然可能没有 sender，不算同步故障。
- unresolved app sender names：官方应用 API 无权限，且会话机器人列表无法唯一匹配时，不强行猜名字；保留 unresolved 标记，作为质量报告里的 advisory。

看最近 worker 日志：

```bash
node scripts/lark-im-service.mjs tail
```

重启后台服务：

```bash
node scripts/lark-im-service.mjs restart
```

重启后等待一个完整成功 cycle：

```bash
node scripts/lark-im-service.mjs wait-ok
```

## Acceptance Check

当前 v0 验收结论见 `docs/v0-baseline.md`。

当初始 catch-up 完成，v0 可以用这组命令验收：

```bash
npm test
npm run check
node scripts/doctor.mjs
node scripts/doctor.mjs --live
node scripts/messages.mjs --limit 20
node scripts/lark-im-service.mjs status
node scripts/lark-im-service.mjs wait-ok
```

预期：

- 测试和检查通过。
- `doctor` 不显示 `NEEDS ATTENTION`。
- `doctor --live` 在可访问 keychain 的环境里是 healthy，或者没有缺失远端热消息。
- `sync-status` 中 `Discovery`、`Hot discovery`、`Reconcile` 分别能看出 initial、hot 和周期复核状态。
- `lark-im-service status` 中 `Worker` 区域能看出最近 cycle 在持续推进。
- 最近消息能正常展示发送人、群名和消息内容。
- 后台服务是 active。

## Boundaries

当前不做：

- UI。
- 语义摘要。
- embedding。
- “已读”建模。
- 新信息源接入。

这些都应该等飞书消息同步基线稳定后再继续。
