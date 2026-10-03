# Exocortex Operations

> 本文描述候选代码的操作契约，不代表这些修改已部署或完成真实运行验收。历史 baseline 不能代替当前机器的独立验收。`maintenance-check` 默认包含构建、测试与服务重启，不属于只读诊断。

显式 `--start` 必须带时区，其起点持久化到 `sources.config_json.initial_sync_start_ms`。空新库省略 `--start` 时，首次运行以当日本地零点建立持久基线；有数据但缺基线的旧库必须显式确认。不同的 `--start` 不能改写已有基线；已有 cursor 继续优先，无 cursor 的 scope 跨日或后来发现时使用同一基线。

这份文档回答一个问题：

```text
我每天怎么知道衍我同步系统是不是正常？
```

当前系统仍是 terminal-first。日常入口必须极简，诊断入口可以更完整，但不应该污染日常心智。

## Known Limits of This Node Implementation

保留现有代码不等于已经解决所有可靠性问题：

- coverage-check 从保留的 `sync_runs` 重建覆盖；清理旧 run 会失去窗口证明，即使记录和 cursor 未变。worker 默认每 1440 个周期自动执行 `prune-runs --apply`，当前 CLI 不接受间隔 0，没有永久禁用开关。调大间隔只能延期，不能解决证据丢失；需要长期连续覆盖证明时，这仍是未解决限制。
- 合并转发详情的受限错误仍可能被按整个 chat 分类并禁用 scope；应独立核对列表与详情失败。
- doctor 子命令非零退出但输出合法健康 JSON 时，可能仍显示本地就绪；不能只靠 doctor 验收。
- 名称解析仍可能把返回的 ID 当名称；独立 enrich-records 脚本没有自动 resolver 的全部批次和超时限制。
- 非整分钟初始基线在短首轮成功后，游标向下取整可能落到基线之前；后续窗口可能包含起点前记录。整分钟起点不触发此特定边界，非整分钟使用仍需修复。
- SQLite 只读查询禁止业务写入，不保证活跃 WAL 的共享内存协调文件逐字节不变。

## Local Setup and Verification

从目标 checkout 根目录执行本文命令。开发检查需要 Node.js 22、npm、SQLite CLI；覆盖工具还需要 Python 3。先在隔离 checkout 安装 lockfile 依赖并检查候选代码：

```bash
npm ci
npm run build
npm run typecheck
npm test
npm run check
```

自动测试使用合成数据与临时目录。真实同步前由本人安装并授权官方 lark-cli，确认账号、读取范围、数据库路径和带时区的首次起点；凭据与个人运行数据不进入仓库。初始化与同步是显式写操作，默认诊断不会创建 schema。替换运行代码前，应停止旧 worker 并确认子进程退出，保存独立一致性备份与原代码/配置；参见 [Safe Runtime Maintenance](#safe-runtime-maintenance)。后台周期、本地状态、固定窗口覆盖和远端采样分别验收，单个绿灯不能证明全量完整。

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

当前本地同步证据是否满足要求，不证明远端全量完整性。

```text
OK           本地检查未发现阻断，或观察到同步活动。
CATCHING UP  正在追赶，还不能说完整。
PROBLEM      当前有需要处理的问题。
```

`OK_WITH_HISTORY` 保留为内部诊断事实，历史失败仍在 `sync_runs`。Service 总览把 `NOT_READY / UNKNOWN / NEEDS_ATTENTION` 映射为 `PROBLEM`。观察到同步活动时也可能显示 `OK`，这不证明同步完整；消息质量由独立 quality 检查或 doctor 组合报告。

### Activity

worker 此刻是否正在执行同步 step。

```text
IDLE     当前没有同步 step 在跑。
SYNCING  当前正在执行同步 step。
```

`SYNCING` 通常是正常活动，不等于故障。

### Freshness

最近一次有界远端采样的证据，不代表所有会话或所有历史消息：

```text
SAMPLED  当前数据库的近期热消息样本在本地均存在，证据尚未过期。
BEHIND   有效样本中发现远端消息尚未入库。
UNKNOWN  缺缓存、已过期、数据库不匹配、旧缓存或采样无结论。
```

Service status 不联网，只读取 `logs/lark-im/live-probe.json`。`doctor --live` 默认只做本次采样；同时加 `--write-live-cache` 才显式写入 v2 缓存。摘要绑定数据库 canonical path 与文件身份的哈希和 `source_id=lark.im`，记录 `recent_hot_messages` 范围、window、sample count、checked_at、expires_at；默认 TTL 为 **五分钟**，不保存 ID、人名、群名、链接或正文。

数据库/来源匹配不等于当前远端账号身份匹配。结果单列 `auth_identity=unknown`，缓存中 `auth_identity_verified=false`；不会额外申请账号授权。切换账号后不得据此复用上一账号 cursor。旧 v1 healthy 缓存不能升级为 SAMPLED；全空样本必须是 INCONCLUSIVE。`restricted_mode` 是被排除会话的原因，与缓存缺失/过期导致的 UNKNOWN 分开解释。

在已授权且能访问 lark-cli Keychain 的环境中，先给 `PROBE_START_ISO`、`PROBE_END_ISO` 设置明确的近期时间窗口，再运行受控采样：

```bash
node scripts/doctor.mjs --db /absolute/path/to/exocortex.sqlite \
  --live --chat-pages 1 --hot-chats 1 --messages-per-chat 3 \
  --start "$PROBE_START_ISO" --end "$PROBE_END_ISO" \
  --write-live-cache --format json
```

缓存写入执行项目的 `logs/lark-im/live-probe.json`，service 的 log directory 必须对应。去掉 `--write-live-cache` 即仅查看本次结果。有效样本在 service 中显示 SAMPLED，并展示范围、窗口、数量、检查/失效时间及身份未知；五分钟后回到 UNKNOWN 是预期行为。`UNAVAILABLE / keychain_unavailable` 只说明当前 shell 未完成远端采样，本地仍可能是 LOCAL_READY。

### Last 24h

`lark-im-service status` 还会展示过去 24 小时的运行证据。这一层不新增健康状态，只帮助判断后台 worker 是否稳定地连续运行过。

```text
Cycles                       过去 24 小时内 worker cycle 的成功/失败/总数。
Last success                 最近一次成功 cycle，按 cycle 序号和距现在多久展示。
Longest between successes    过去 24 小时内，相邻两次成功 worker cycle 之间的最长间隔；如果窗口开始到第一次成功、或最后一次成功到现在更长，也计入。
Failures                     过去 24 小时内失败 cycle 数、失败 step 聚合计数，以及可分类的失败原因聚合计数。
```

`Longest between successes` 衡量的是“成功之间的最大断档”，不是“这段时间完全没有发生同步”。例如成功时间是 `10:00, 10:01, 10:02, 10:43, 10:44`，中间的最大断档是 `10:02 -> 10:43`，显示为 `41m`。

### Transient Lark Failures

飞书 OpenAPI 偶尔会返回瞬时失败。当前已明确按 transient 处理的类型包括：

```text
network_timeout
network_error
service_unavailable
internal_error
rate_limited
```

其中 `rate_limited` 对应 lark-cli 返回的 `9499 / too many request`。同步器会对这类失败做有限次指数退避重试；只有重试预算耗尽后，才会留下 failed run。failed run 不会推进 cursor，后续 cycle 会从旧 cursor 继续，因此单次已恢复的 `rate_limited` 记录不等于当前同步故障。

可以用下面命令查看最近历史失败的分类：

```bash
node scripts/lark-im-service.mjs status
node scripts/lark-im-quality.mjs
node scripts/sync-status.mjs
```

## Read-only Diagnostics and Explicit Repair

默认 `sync-status`、`doctor`、`lark-im-quality`、`messages`、`lark-im-service status` 的 SQLite 查询使用已有库上的 `-readonly` 与 `query_only`，不 recovery、不执行 DDL/DML、不 chmod、不写 freshness cache。缺库或缺表会失败，不自动初始化。Messages 仍是展示本人私有内容的阅读入口。`--live` 与 lag-check 会读取远端，显式缓存写入另由 `--write-live-cache` 控制。

Doctor 的 LOCAL_READY 只表示本地证据；SYNCING/CATCHING_UP 是活动或追赶；NOT_READY/UNKNOWN/NEEDS_ATTENTION 不能作为完成验收。空库或缺少发现/成功消息 scope 证据是 NOT_READY，只有失败记录是 NEEDS_ATTENTION。非空有界 live 样本通过时可显示 SAMPLED；若本地仍在同步或追赶，overall 保留相应状态，live 部分单独展示样本。

只读查看遗留锁/run 的结构计数：

```bash
node scripts/sync-repair.mjs --db /absolute/path/to/exocortex.sqlite --format json
```

预览不判断 owner 存活，也不代表候选一定会被修复。确认需要恢复、停止 worker 并确认无并行同步/维护后，再显式执行：

```bash
node scripts/sync-repair.mjs --db /absolute/path/to/exocortex.sqlite --apply --format json
```

Apply 在事务中检查 owner/lease/run 条件并报告实际变更计数，不回灌旧库或回退 cursor。默认只读诊断不调用 recovery；同步写路径在取得 scope 锁前仍会执行该 scope 的 stale recovery，显式 repair 不是唯一恢复入口。Service 的 `--db` 只支持 status/wait-ok 并传入诊断查询，不改变已安装 worker 的配置。

## Initial Catch-Up Done

初始追赶完成需要同时满足发现、进度和实际扫描覆盖要求；单独的 doctor 绿灯或 cursor 终点不足以证明首日没有遗漏：

```text
received_without_cursor = 0
discovery.has_more = false
source.initial_sync_start_ms = 已确认的持久基线
各启用 sent/received scope 的成功窗口从基线连续覆盖到固定验收终点
```

每次验收固定自己的终点。工具检查成功 run 的实际 `window_start` / `window_end` 及前后 cursor；允许边界重放和重叠，缺口、失败窗口或缺少证据不能算完成。禁用/不支持 scope 单独列出。候选版本的 doctor、sync-status 和 service status 已移除 recovery，但仍不能替代覆盖验收。

先将 `COVERAGE_TARGET_ISO` 设置为带时区的验收终点，再使用项目内的只读验收工具：

```sh
python3 -B scripts/lark-im-coverage-check.py --target "$COVERAGE_TARGET_ISO"
```

`--db` 默认定位脚本所在项目的 `data/exocortex.sqlite`；起点自动读取该库的持久基线，`--target` 必须是显式带时区的 ISO 时间且晚于起点。以后部署应选择自己的目标时间，不复用历史验收日期。退出码 `0` 表示完整覆盖，`2` 表示未完成或检查错误；结合聚合 JSON 中原因判断。缺库或缺基线时失败，工具不负责 seed、不创建数据库，也不修改权限、游标或运行状态。新库的基线由首次同步初始化。

## Restart After Downtime

同步器必须假设自己可能很久没有正常运行。重启后的目标不是“从现在开始同步”，而是：

```text
从每个 Scope 上次持久化 Cursor 继续追赶到当前稳定边界
```

正常恢复路径：

1. `sent_by_me` 从自己的 Cursor 继续拉取我在停摆期间发出的消息。
2. 已知 `received.chat.*` 由公平 steady-state lane 按持久化的最近尝试时间轮转，并为已有游标和未初始化 scope 保留名额；hot lane 提供低延迟加速。失败尝试也参与排序，详见热会话轮转与公平调度。
3. `discover-hot` 继续扫描最近活跃会话，发现新的活跃非免打扰会话。
4. 未完成的 full discovery snapshot 用持久化 `page_token` 继续扫后续页。
5. 无 cursor 的 scope 从来源配置中的持久初始基线开始；不能因重启发生在次日就改用新的当天零点。缺基线的有数据旧库必须先显式确认起点，不能直接以默认值继续。

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

写入 SQLite 私有库的维护动作必须通过全局 maintenance lock，避免维护命令和后台同步同时写库，制造 `database is locked` 的瞬时失败。典型写库维护包括：

```bash
node scripts/lark-im-enrich-scopes.mjs --limit 100
node scripts/lark-im-enrich-records.mjs --limit 3000 --probe-apps
node scripts/sqlite-maintenance.mjs prune-runs --apply
```

这些命令会在写库前获取全局维护锁。维护锁存在时，worker 的 sync step 会跳过本轮而不是创建 failed run；如果维护命令启动时已经有 active sync lock，它会失败并提示稍后重试。

常规流程可以不手动停止 worker：

```bash
node scripts/sqlite-maintenance.mjs backup
node scripts/sqlite-maintenance.mjs verify --latest
node scripts/sqlite-maintenance.mjs prune-runs --apply
node scripts/sqlite-maintenance.mjs check
node scripts/doctor.mjs
```

如果连续遇到 active sync lock，或者要执行较长时间的 repair，再使用保守流程：

```bash
node scripts/lark-im-service.mjs stop
```

执行写库维护和检查：

```bash
node scripts/sqlite-maintenance.mjs backup
node scripts/sqlite-maintenance.mjs verify --latest
node scripts/sqlite-maintenance.mjs prune-runs --apply
node scripts/sqlite-maintenance.mjs check
```

然后恢复并等待一个新成功 cycle：

```bash
node scripts/lark-im-service.mjs start
node scripts/lark-im-service.mjs wait-ok
node scripts/doctor.mjs
```

全局维护锁有 TTL。正常退出会释放；异常退出后，后续维护或 worker 会在 TTL 过期后回收。

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

`--live` 会额外运行 `node scripts/doctor.mjs --live`，需要当前 shell 能访问 `lark-cli` auth/keychain；它不会自动刷新 service freshness 缓存。只想跑检查和诊断、不重启后台服务时：

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

`maintenance-check` 不直接修复消息记录，但会构建、测试并默认重启 worker；worker 恢复后正常写库，因此这不是只读入口。若它因为 data quality 失败，先显式运行对应 maintenance repair，例如：

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
node scripts/sync-status.mjs
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

候选版本的 backup v2 manifest 绑定源库身份；保留清理只处理经过验证且属于该源库的备份，不扫描删除同目录任意 SQLite。无归属信息的 legacy 备份不参与自动清理或 latest 选择，只能显式指定路径 verify。Records/scopes 富化使用条件写入，快照已变化时记录冲突而不覆盖新状态。富化的 `--dry-run` 不写库，但仍可能调用只读远端 API，不是离线模拟。

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
node scripts/sqlite-maintenance.mjs prune-runs
node scripts/sqlite-maintenance.mjs compact
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

`backup` 会先取得全局 maintenance lock，生成一致快照，移除快照里的临时 lock，再写入同名的私有 manifest。manifest 记录快照自身的 SHA-256、大小和创建时计数；备份和 manifest 均强制为 `0600`。新建备份目录以 `0700` 创建；已有目录必须是真目录、不能是符号链接、不能允许组或其他用户写入，代码不会把已有 `0755` 目录自动改成 `0700`。只有新快照完整通过 integrity、计数和 manifest 校验后才会执行保留清理；失败的新快照会被丢弃，不能挤掉旧的可用恢复点。默认保留最近 7 份且不超过 30 天，可用 `--backup-keep-count` / `--backup-keep-days` 调整。

`verify --latest` 会打开最新备份，重新跑 integrity / foreign-key check，并核对该快照自己的 manifest、SHA-256、大小和计数。它不再把历史快照和持续变化的当前数据库比较，因此当前库后来新增消息不会让有效旧备份误报失败；备份内容即使保持行数不变，只要发生变化也会被 hash 检出。没有 manifest 的旧备份会明确报告为不可验证，而不是冒充验证成功。输出只包含状态、相对路径、计数和校验结果，不展示消息内容、人名、群名、链接或 raw payload。

`prune-runs` 用来控制 `sync_runs` 的长期增长。规则保持简单：

```text
删除 14 天前、没有造成 durable record insert/update 的 succeeded runs。
```

也就是处理空轮询和 duplicate-only 轮询，但必须同时满足：没有写入、没有更新，且没有被任何 scope 当作 `last_success_run_id` 引用。它不删除 `running`、`failed`、`cancelled`、有实际数据变化的成功 run，或当前 scope 引用的最新成功 run。后台 worker 默认每 1440 个 cycle 自动执行一次该保留策略，避免运行历史再次无限增长。

默认只 dry-run：

```bash
node scripts/sqlite-maintenance.mjs prune-runs
```

确认候选数量合理后，才显式执行：

```bash
node scripts/sqlite-maintenance.mjs prune-runs --apply
```

`prune-runs --apply` 只删除运行日志，不删除 `records` 消息事实，也不推进或修改 cursor。它会通过全局 maintenance lock 和后台同步写入互斥；如果正好有 active sync lock，稍后重试即可。删除后的空闲页不会自动缩小文件；需要实际回收空间时，显式运行 `node scripts/sqlite-maintenance.mjs compact`，该动作同样受 maintenance lock 保护。

SQLite 数据库、WAL/SHM、备份、worker 日志和 live probe cache 都属于私有运行数据。写路径负责私有权限初始化；默认诊断和缓存读取不 chmod。显式缓存写入使用 `0700` 目录及 `0600` 文件。LaunchAgent 同时配置 `Umask=63`；worker JSONL 按 10 MiB 轮转并默认保留 5 个历史文件，launchd stdout 指向 `/dev/null`，避免和 `worker.jsonl` 重复落盘。

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

新增自动化测试输入必须从零构造，使用假 CLI 与临时数据库；真实运行数据及其脱敏派生样例不得作为测试输入。

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

候选代码需独立部署验收。

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
- `doctor` 的本地证据为 LOCAL_READY；NOT_READY/UNKNOWN/NEEDS_ATTENTION 不算完成。
- 固定终点的 coverage-check 确认成功窗口连续覆盖，单次成功 cycle 不足以证明完整。
- `doctor --live` 获得非空、窗口明确、无 missing 的样本；全空、不可用和错误均不能算远端通过。
- 如需 service 展示样本，显式写缓存并在五分钟内检查 SAMPLED 及范围，当前认证主体仍未知。
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


## 限流恢复与自适应追赶

飞书频控通常以「接口 × 应用 × 租户」计数，不是每个会话一份额度。已核实的接口包括：消息列表/指定消息/会话列表/群成员均为 1000 次/分钟且 50 次/秒；`POST /contact/v3/users/basic_batch` 为 5 次/秒、每批最多 10 人；消息搜索为 100 次/分钟、每页最多 30 条；应用信息查询为 50 次/秒。任一时间窗口达到上限都会限流。依据：

- [频控总则](https://open.feishu.cn/document/server-docs/api-call-guide/frequency-control)
- [消息列表](https://open.feishu.cn/document/server-docs/im-v1/message/list)、[指定消息](https://open.feishu.cn/document/server-docs/im-v1/message/get)
- [会话列表](https://open.feishu.cn/document/server-docs/group/chat/list)、[群成员](https://open.feishu.cn/document/server-docs/group/chat-member/get)
- [basic_batch](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/contact-v3/user/basic_batch)、[消息搜索](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/search)
- [应用信息](https://open.feishu.cn/document/server-docs/application-v6/application/get)

`POST /contact/v3/users/search`、群内 bots、mute status、mget、chats batch_query 和 CLI 的 accounts OAuth v3 token 入口，尚无本次核实的数值频控；user_info 官方仅写特殊频控。未知不是无限制，也不是已经超限的证据。同名的旧 `GET /search/v1/user` 和 `GET /contact/v3/users/batch` 不能替代实际接口规则。

恢复层识别 429、旧 400 加 99991400 以及结构化 rate_limit；可取得 `x-ogw-ratelimit-reset` 时完整尊重秒数，不能为了重试预算把等待截短。CLI 未暴露响应头时，只能使用明确标为 fallback 的保守退避。每条 CLI 操作有有限重试次数和总时间预算。可选姓名补充单次操作预算为 5 秒，预算不足时保留缺名并延期，不应长期阻塞消息入库。这是应用优先级，不是飞书官方配额。

冷却按可确定的操作分别保存，并跨 worker 的 sync 子进程传递。history/search 的 bundle 名称保留兼容已有冷却和遥测；消息采集改为显式原生 list、search、mget 和必要的 merge 详情请求。chat discovery 与部分姓名查询仍使用官方 CLI 快捷命令，不能精确看到其所有内部 HTTP 请求。此实现不修改第三方 CLI，不声称已经实现完整的逐 endpoint HTTP 调度；同应用其他客户端的用量也必须计入。独立 contact/member/app/bot 操作冷却不应成为全局 sleep。

联系人按 30 个 ID 一批，显式请求 page-size 30，避免 CLI 默认只返回 20 条且不自动翻页。消息搜索按官方上限最多 30 条，received 历史仍最多 50 条；原有游标分页、时间窗口和过滤不变。resolver 只在内存缓存成功解析的直接 user/app/chat-member 名称：总容量 1000、TTL 5 分钟，成员按会话隔离，不缓存失败或机器人推断。

worker 默认仍使用固定批量；显式 `--adaptive-fair` 才启用自适应。示例 worker 参数：

```sh
--received-scopes-per-cycle 25 --interval-seconds 30 \
--adaptive-fair --adaptive-fair-min 10 --adaptive-fair-max 50 \
--adaptive-target-cycle-seconds 90
```

目标周期包括实际工作和休眠。连续两个完整健康周期后最多加 5，并按已观测的 fair 每 scope 耗时和其他步骤耗时限制下一轮预算；失败、已暴露的限流、超时或重试耗尽会减半，最低 10。缺少统计不能作为提速依据。它是吞吐/延迟控制，不是 QPS limiter；成功也不证明 CLI 内部没有限流。

`summary.transport` 的 calls/attempts/retries 是外层 CLI 命令计数，不是 HTTP 请求数。worker 的 scheduler 事件记录有效批量、下一批量、决策原因和耗时。正常摘要以及出错时的专用 transport 摘要都保留脱敏计数和操作冷却，不写远端正文、token 或真实资源 ID。

调整 LaunchAgent 前应停止单实例、检查子进程退出、用 SQLite 原生 backup 保存独立副本，并备份当前代码及 plist。service install 尚不透传自适应参数；需要在停止后审核修改已有 plist 的 ProgramArguments，或直接使用 worker 参数，不要重新 install 丢失定制参数。部署后以新 PID、多个完整周期、只读数据库与固定目标覆盖检查验收。退化时恢复此次部署前代码和配置，**不要恢复旧数据库**，以免丢失部署期间的新记录与游标进度。

## 原始消息与有界回填

received 直接分页读取原生消息列表，显式请求 `only_thread_root_messages=false`；sent 先搜索 ID，再以 mget 严格核对全部详情。错误信封、缺详情、重复详情、循环分页 token 或不完整分页均使窗口失败，不推进游标。查询的秒级边界向外取整，最终记录按原始毫秒起止裁剪。search 时间按官方契约使用无小数秒的 ISO8601。

原始 `body.content`、`update_time`、root/parent/thread 关系进入 `raw_json`。正文是可重建投影，canonical 保留 `content_rendering` 状态与版本。复杂卡片、图片和未知结构保留原始 JSON 并明确标注未完整渲染；不会凭空补用户姓名。合并转发的完整原生子项进入 `raw_api_expansions`，子项不冒充当前会话里的独立消息。

每个 adapter 窗口共享 180 秒请求预算；合并转发详情最多 `min(maxPages,50)` 次、1000 项、64 层关系。超过预算拒绝截断成功。正常同步可沿用窗口二分完成较小前缀，worker 的 600 秒步骤上限仍有效。有界回填不二分，任何未完成 scope 均不提交。

旧游标覆盖仅证明成功扫描窗口连续，不能证明旧 CLI 展开策略没有漏消息。明确选样对账后，可在停止 worker、完成一致备份和显式迁移后执行：

```sh
node scripts/lark-im-replay.mjs --db data/exocortex.sqlite \
  --scope-id '<已确认的 received scope>' \
  --start '<带时区的固定起点>' --end '<带时区的固定终点>'
# 审阅预览后，以完全相同参数加 --apply。
```

命令最多选择三个 scope，起点不得早于持久基线，默认只读预览仍会读取远端。完整获取后才短时获取维护锁；事务内重新验证锁、scope 配置与基线。记录与 `bounded_replay_runs` 审计同事务提交，正常 `sync_runs` 和全部游标不变。已有记录仅在双方版本均为数字且新版本严格更高时更新；未知或同版本冲突保留现状并报告。中断后可原命令重跑。

live freshness 对热会话原始列表的首屏（含回复）仅做消息 ID 存在性采样，不追页、不展开转发，不代表正文版本对账或全量完整性。话题会话的真实样本不能证明所有普通群内嵌话题都已覆盖；缺少对应样本时应保留这个未验证边界。

## 热会话轮转与公平调度

热队列从最近十分钟发现的前 20 个排名候选中，按持久化的最近尝试时间选择；排名只用于并列排序。失败、取消和运行中的尝试都参与轮转，重启不重置位置。每轮仍以 `--hot-received-scopes-per-cycle` 控制数量。刚成功追近当前时间的会话在热队列跳过 60 秒；较旧前缀的成功仍可继续追赶。发现排名是活动线索，不是消息发生时间。

公平队列为已有游标和未初始化会话交替保留执行名额；同一类遇锁先在本类补位，该类无可用候选后才借出余量。失败尝试重新排队，新会话以创建时间参与排序，持续发现不会使旧会话失去执行机会。每类最多检查 `max(3×limit, limit+20)` 个候选；实际开始的 scope 不超过批量，HTTP 分页和重试次数仍由各自预算控制。维护锁使本轮立即停止。

正常锁跳过不会计为采集失败，也不会作为成功吞吐帮助自适应增长。有效批次不足时保持批量；明确失败、限流和超时仍收缩。验收应分开报告热池与其余会话的 cursor 延迟、实际执行的不同 scope 数和冷队列进展。热池及时不等于全部会话都达到分钟级实时。
