# Exocortex Operations

> 本文描述候选代码的操作契约，不代表这些修改已部署或完成真实运行验收。历史 baseline 不能代替当前机器的独立验收。CLI v2 的默认检查只读；服务生命周期与开发验证分开。命令与参数以 [生成目录](commands.md) 为准，旧入口和默认差异见 [迁移清单](cli-migration.md)。

显式 `sync --start` 必须带时区，其起点持久化到 `sources.config_json.initial_sync_start_ms`。空新库省略 `--start` 时，首次运行以当日本地零点建立持久基线；有数据但缺基线的旧库必须显式确认。不同的 `--start` 不能改写已有基线；已有 cursor 继续优先，无 cursor 的 scope 跨日或后来发现时使用同一基线。

这份文档回答一个问题：

```text
我每天怎么知道衍我同步系统是不是正常？
```

当前系统仍是 terminal-first。日常入口必须极简，诊断入口可以更完整，但不应该污染日常心智。

## Known Limits of This Node Implementation

保留现有代码不等于已经解决所有可靠性问题：

- coverage-check 从保留的 `sync_runs` 重建覆盖；清理旧 run 会失去窗口证明，即使记录和 cursor 未变。worker 默认每 1440 个周期自动执行 `prune-runs --apply`，当前 CLI 不接受间隔 0，没有永久禁用开关。调大间隔只能延期，不能解决证据丢失；需要长期连续覆盖证明时，这仍是未解决限制。
- 姓名查询受远端可见性和有界群成员扫描限制；ID 回显或失败保持未知。单目标 sender-only 补全有整轮预算，常规 enrich 的记录扫描上限不等于整轮时间上限。
- 非整分钟初始基线在短首轮成功后，游标向下取整可能落到基线之前；后续窗口可能包含起点前记录。整分钟起点不触发此特定边界，非整分钟使用仍需修复。
- SQLite 只读查询禁止业务写入，不保证活跃 WAL 的共享内存协调文件逐字节不变。

## Local Setup and Verification

从目标 checkout 根目录执行本文命令。开发检查需要 Node.js 22、npm、SQLite CLI 3.35 或更新版本（含 JSON 函数）；记录事务使用 RETURNING，姓名合并使用 MATERIALIZED CTE 防止查询展开。覆盖工具还需要 Python 3。先在隔离 checkout 安装 lockfile 依赖并检查候选代码：

```bash
npm ci
npm run verify
```

`verify` 是开发配方：完成 build、typecheck、syntax、test 和生成物对照，不调用 service 或 maintenance 命令。构建仍写当前 `dist`，只应在隔离开发 checkout 执行。运行维护按下文显式停服、替换已验证候选、启动及验收；检查命令不会代为重启。

自动测试使用合成数据与临时目录。真实同步前由本人安装并授权官方 lark-cli，确认账号、读取范围、数据库路径和带时区的首次起点；凭据与个人运行数据不进入仓库。初始化与同步是显式写操作，默认诊断不会创建 schema。替换运行代码前，应停止旧 worker 并确认子进程退出，保存独立一致性备份与原代码/配置；参见 [Safe Runtime Maintenance](#safe-runtime-maintenance)。后台周期、本地状态、固定窗口覆盖和远端采样分别验收，单个绿灯不能证明全量完整。

## Daily Commands

日常只需要记住三个命令：

```bash
npm run help
```

查看核心命令入口。

```bash
node bin/exocortex.mjs messages --limit 20
```

查看最近同步到本地的消息。

```bash
node bin/exocortex.mjs status
```

查看后台同步服务是否在运行，以及当前同步状态。

完整命令目录只在需要时查看：

```bash
npm run help -- --all
```

## Status Model

`status` 的主状态分成四层，避免把进程、同步、实时活动和远端对照混在一起。

### Service

后台是否会继续自动同步。

`LaunchAgent` 是 macOS 后台服务管理器；`worker` 是真正执行同步的 Node 进程。

```text
RUNNING  LaunchAgent 已加载，worker 进程活着。
STOPPED  LaunchAgent 未加载，或已加载但 worker 进程没起来。
```

另有 `UNKNOWN`：无法确认 launchd 状态。只有成功的 `launchctl print` 或明确的 service-not-found 结果才能判定加载或未加载；权限错误、命令启动失败和其他异常不能当作 STOPPED。细节里继续展示 LaunchAgent loaded、PID 和 last exit。

`launchctl print` 中只有服务自身的直接 `state`、`pid` 和 `last exit code` 字段能证明运行状态；嵌套资源组或子进程的同名字段不能覆盖或补齐它们。结构未闭合、缩进歧义或重复直接字段不提供肯定运行证据；查询成功仍可证明已加载，但不能据此声称正在运行或完成新周期。

`service install` 只校验并原子保存配置，不启动服务。正在运行的配置若不同则拒绝覆盖，需先显式 stop；相同配置可直接保留。`--db`、日志目录及共同 WorkerConfig 都解析后固化；`--once` / `--max-cycles` 不进入常驻配置。

`service start` 是 ensure-running：已确认运行时不更换实例；已加载但未运行时请求非强制 kickstart，未加载时 bootstrap 后启动。无法检查时失败。`service restart` 才明确执行 stop → start。启动返回 0 只表示请求已接受，持续运行与新周期用 `check --wait` 验收。

`stop` 与 `uninstall` 必须确认 job absent；unknown 不能冒充停止，uninstall 在停止或确认失败时保留 plist。安装校验、文件替换与回滚失败都显式报告，不把磁盘配置恢复等同于进程恢复。现有安装配置的迁移门槛见 [W](cli-migration.md#worker-切换门槛-w)。

### Health

当前本地同步证据是否满足要求，不证明远端全量完整性。

```text
OK           本地检查未发现阻断，或观察到同步活动。
CATCHING UP  正在追赶，还不能说完整。
PROBLEM      当前有需要处理的问题。
```

`OK_WITH_HISTORY` 保留为内部诊断事实，历史失败仍在 `sync_runs`。Service 总览把 `NOT_READY / UNKNOWN / NEEDS_ATTENTION` 映射为 `PROBLEM`。观察到同步活动时也可能显示 `OK`，这不证明同步完整；`check` 另按本地 ready、零详情欠账、质量和数据库证据验收。

### Activity

当前同步活动需要同一数据库上的阶段记录、匹配的进程实例和时间证据。完整设计与合成反例见 [Activity 证据](activity-evidence.md)。

```text
SYNCING  当前实例处于已验证的周期/步骤，或观察到独立前台同步阶段。
WAITING  已验证的 worker 声明处于周期间隔，且没有矛盾活动证据。
STOPPED  后台已停，且未观察到活跃或身份未知的同步进程。
UNKNOWN  缺阶段、过期、进程检查失败、重启身份变化或证据矛盾。
```

锁表示互斥，遗留 running 行和未结束的历史 cycle 都不能单独证明当前活动。当前阶段按日志追加顺序、实例及数据库绑定选择，不按可重置的周期号或最大时间戳猜测。worker 步骤使用真实子进程硬超时；间隔使用下次运行时间。独立前台没有整体硬期限，只在真实阶段转换后的五秒观察窗口内可证明活跃，长阻塞后诚实显示 UNKNOWN。新 worker 启动后才会产生这些阶段；旧日志不能补造它们。

Service STOPPED 仍可同时存在独立前台 Activity SYNCING。共享 sync report 只读取数据库证据，其 `current_activity.evidence=database_only` 不能证明阶段；锁或遗留 run 导致 UNKNOWN，不再声称 currently syncing。Service 另有阶段与 OS 观察，因此可得出更具体结果；这些检查并非原子 OS 快照，期限按最终观察时间校验。公共 JSON 保留兼容 `status`（waiting/stopped 对应 idle），新增精确 `state` 和有限时间证据，不公开进程或原始锁标识。Activity 不证明健康、完整覆盖或远端新鲜度。

### Freshness

最近一次有界远端采样的证据，不代表所有会话或所有历史消息：

```text
SAMPLED  当前数据库的近期热消息样本在本地均存在，证据尚未过期。
BEHIND   有效样本中发现远端消息尚未入库。
UNKNOWN  缺缓存、已过期、数据库不匹配、旧缓存或采样无结论。
```

`status` 不联网，只读取 `logs/lark-im/live-probe.json`。`check --live` 默认 chat-pages=5、hot-chats=5、messages-per-chat=3，窗口为当日本地零点到调用时刻；只做本次采样；同时加 `--write-live-cache` 才显式写入 v2 缓存。摘要绑定数据库 canonical path 与文件身份的哈希和 `source_id=lark.im`，记录 `recent_hot_messages` 范围、window、sample count、checked_at、expires_at；默认 TTL 为 **五分钟**，不保存 ID、人名、群名、链接或正文。

数据库/来源匹配不等于当前远端账号身份匹配。结果单列 `auth_identity=unknown`，缓存中 `auth_identity_verified=false`；不会额外申请账号授权。切换账号后不得据此复用上一账号 cursor。旧 v1 healthy 缓存不能升级为 SAMPLED；全空样本必须是 INCONCLUSIVE。`restricted_mode` 是被排除会话的原因，与缓存缺失/过期导致的 UNKNOWN 分开解释。

在已授权且能访问 lark-cli Keychain 的环境中，先给 `PROBE_START_ISO`、`PROBE_END_ISO` 设置明确的近期时间窗口，再运行受控采样：

```bash
node bin/exocortex.mjs check --db /absolute/path/to/exocortex.sqlite \
  --live --chat-pages 1 --hot-chats 1 --messages-per-chat 3 \
  --start "$PROBE_START_ISO" --end "$PROBE_END_ISO" \
  --write-live-cache --format json
```

缓存写入安装 root 的 `logs/lark-im/live-probe.json`，service 的 log directory 必须对应。去掉 `--write-live-cache` 即仅查看本次结果。有效样本在 service 中显示 SAMPLED，并展示范围、窗口、数量、检查/失效时间及身份未知；五分钟后回到 UNKNOWN 是预期行为。`UNAVAILABLE / keychain_unavailable` 只说明当前 shell 未完成远端采样，不等于后台同步故障。`check` 保留本地 health 证据，采样不可用或执行失败不能给出绿色整体结果。

`check` 直接调用共享报告，不通过已退役的诊断子 CLI 拼接结果。执行失败、信号、坏 JSON 或有效但未满足的证据不能被健康字段覆盖。公共结果使用有限原因、状态和计数，不透出原始 stderr；本地与远端分项保留各自观察时间。

### Status 的整屏层级与历史口径

公共 `status` 按当前判断、同步进度、需处理项、近期历史排列；`--detail` 使用同样的标题和键值布局，并补充 Diagnostics，不直接拼接 JSON。字段契约与从零合成整屏见 [Status screen design](status-screen-design.md)。

- **Health & current work**：Local health 仅指本地同步检查；不是质量检查或远端完整性保证。Background 单列服务运行及所选数据库关联。Current work 只使用已验证 Activity，并翻译当前任务名；Unconfirmed 旁解释缺失或冲突证据。
- **Coverage**：分别显示保存的消息、收到的会话、消息列表最落后水位、详情欠账和会话名单完成情况。收到的会话数不与包含 sent 的消息源分母混用；列表进度不等于完整内容覆盖。Restricted chats 保留原因、数量、错误码。缓存远端样本过期不等于后台失败。
- **Attention**：给出对应诊断入口；所有建议命令都须沿用本次 status 的 `--db` 和 `--log-dir` 值，界面只说明这一要求，不输出私有路径。没有或过期的远端样本单列为 Optional sample，不作为必须处理的问题；旧成功、未收尾历史和租约都不直接建议 repair 或 restart。`check --live` 取得本次样本，只有显式增加 `--write-live-cache` 才更新供后续 status 使用的缓存。
- **Recent history**：worker 日志的轮次/任务和所选数据库的失败运行独立统计。日志未验证绑定所选数据库，轮次号也会因重启重置，因此不以轮次号当全局身份。

默认显示日志请求回看长度、窗口内事件首末时间及部分/截断状态。detail 给出请求窗口的精确端点、最长成功间隔、最新已完成任务和有步骤却未见收尾的历史。只有旧事件时明确“窗口内无事件”，旧结果仍带日期；未来或无效时间不能写成刚刚成功。成功间隔只计算窗口内相邻成功完成，不包括窗口边界，不代表停机时长。少于两个成功时不可用。

日志只读当前 `worker.jsonl` 最多 8 MiB、20,000 个非空行，不读轮转历史。达到回看左边界也不证明连续运行或无遗漏。数据库失败统计只计算保留的 `sync_runs` 中 `status=failed` 且开始时间位于其独立闭区间内的行，按安全类别聚合；查询失败显示不可用，不能说零失败。查询先冻结截止时间，活动仍在全部读取结束后验证有效期。JSON 中既有 `stability.failures.by_kind` 保留兼容语义，新 `failure_runs` 给出来源、时间基础和精确窗口。

detail 保留初始名单发现、活跃会话刷新成功时间、名单复核完成时间、消息源分母、详情最老欠账/下次重试、保留运行计数、预约异常和时间证据。名单完成只代表名单：hot/reconcile 读取未静音的群聊和私聊，不能据此断言这些会话的消息覆盖完整。正常预约不作为当前活动正判；过期预约不证明进程已死。

整屏声明一次本地 IANA 时区；跨日和跨年保留两端日期，DST 切换/重复小时按需显示偏移。不到一分钟的区间保留秒，避免正区间看起来长度为零。无色和窄屏保留全部字段含义，详情 JSON 的原字段和精确时间仍可用。

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
node bin/exocortex.mjs status
node bin/exocortex.mjs check
node bin/exocortex.mjs status --detail
```

## Read-only Diagnostics and Explicit Repair

默认 `status`、`messages` 和 `check` 在既有库上只读查询，不 recovery、DDL/DML、chmod、写缓存或控制服务。缺库或缺表会失败，不自动初始化。Messages 保留私有正文；`status --logs` 显式增加私有日志，默认摘要和 JSON 是白名单投影。

`check` 固定聚合 database、sync、quality 三块。默认通过要求本地 ready（内部 ok/ok_with_history）、详情证据可用且 pending=0、质量与数据库通过，不要求服务运行。catching_up、未满足或证据不足返回 2；参数、必需依赖、读取/执行失败返回 1。成功读取的 `status` 可以返回 0 而 Health 为 PROBLEM；这与严格验收不同。

四种显式扩展为 `--live`、`--through`、`--backup` / `--latest-backup`、`--wait`。先校验所有参数和所需依赖；需要等待时先等待，再取得最终本地快照，检查 coverage/backup，最后 live，只有显式要求才写 cache。等待失败保留本地证据，live/cache 标记 skipped。Sync 的欠债、列表水位、runs、locks 仍来自同一 SQLite 快照；其他分项注明各自时点。

`--wait` 默认每 5 秒轮询，最多 180 秒，要求运行中的服务、调用后新的完整成功 cycle、无 in_progress/unfinished，且最终本地验收通过。旧成功、有效锁或启动请求接受都不能替代新周期。它不 start 或 restart；没有服务时用默认 check 验本地事实。

只读查看遗留锁/run 的结构计数：

```bash
node bin/exocortex.mjs maintenance repair --db /absolute/path/to/exocortex.sqlite --format json
```

预览不判断 owner 存活，也不代表候选一定会被修复。确认需要恢复、停止 worker 并确认无并行同步/维护后，再显式执行：

```bash
node bin/exocortex.mjs maintenance repair --db /absolute/path/to/exocortex.sqlite --apply --format json
```

Apply 在事务中检查 owner/lease/run 条件并报告实际变更计数，不回灌旧库或回退 cursor。默认只读诊断不调用 recovery；同步写路径在取得 scope 锁前仍会执行该 scope 的 stale recovery，显式 repair 不是唯一恢复入口。`status --db` 与 `check --db` 只改变诊断目标，不改变已安装 worker 配置；与服务实际数据库的匹配未知时如实报告。

## Initial Catch-Up Done

初始追赶完成需要同时满足发现、进度和实际扫描覆盖要求；单独的本地 check 通过或 cursor 终点不足以证明首日没有遗漏：

```text
received_without_cursor = 0
discovery.has_more = false
source.initial_sync_start_ms = 已确认的持久基线
各启用 sent/received scope 的成功窗口从基线连续覆盖到固定验收终点
```

每次验收固定自己的终点。工具检查成功 run 的实际 `window_start` / `window_end` 及前后 cursor；允许边界重放和重叠，缺口、失败窗口或缺少证据不能算完成。禁用/不支持 scope 单独列出。默认 check 与 status 不执行 recovery，但仍不能替代覆盖验收。

先将 `COVERAGE_TARGET_ISO` 设置为带时区的验收终点，再使用项目内的只读验收工具：

```sh
node bin/exocortex.mjs check --through "$COVERAGE_TARGET_ISO"
```

默认 DB 相对安装 root 为 `data/exocortex.sqlite`；显式相对 `--db` 按当前 cwd 解析。`--through` 必须是带时区的固定 ISO 终点且晚于持久基线，等待期间也不漂移。内部唯一 Python 覆盖实现从保留的成功窗口独立取证；主命令把未完成映射为 2，读取/依赖/解析错误映射为 1，并保留 coverage 分项。缺库或缺基线不会 seed、建库、改权限或游标。

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

开发验证、运行代码切换、服务重启和运行验收是四个明确步骤。`npm run verify` 会写当前 `dist`，应先在隔离 checkout 完成；`check` 只读已有运行证据，不构建、不修复、不重启。开发任务见 [Development](development.md)。

运行 worker 会继续 import 安装根中的 `bin`、`src`、`dist` 和配置。不要逐文件覆盖仍在运行的代码。授权切换时先保存原代码与配置、独立一致性数据库备份，再停止旧 worker 并确认其子进程和独立前台同步均已退出：

```bash
node bin/exocortex.mjs service stop
node bin/exocortex.mjs status
```

`stop` 必须确认 absent；权限不足或 unknown 时停止切换，不能继续改运行文件。launchd 停止不证明独立前台同步已退出；还应核对进程身份与写入 fence，确认没有活跃写者。未知任务不能强杀，证据不足时停止切换。随后一次性放入已经验证的完整候选；若变更安装配置，用明确参数执行 `service install`，它只安装不启动。还需核对已安装 plist 的 worker 路径及完整参数，不能仅凭生成器的合成测试宣称真实切换完成。

```bash
node bin/exocortex.mjs service start
node bin/exocortex.mjs check --wait --timeout-seconds 180
node bin/exocortex.mjs status --detail
```

检查失败时保留分项证据；不要把启动请求接受当作验收。需要回退时恢复此次切换前的代码和配置，**不覆盖回灌旧数据库**，避免丢失运行期间的新记录和游标进度。worker 入口切换的固定取证与后续部署门槛记录在 [迁移清单](cli-migration.md#worker-切换门槛-w)，源树删除不等于运行环境已完成退役。

### 检查、重启、等待分别执行

只做当前本地检查：

```bash
node bin/exocortex.mjs check
```

确实要更换运行实例时，明确重启，再等待调用后的新周期：

```bash
node bin/exocortex.mjs service restart
node bin/exocortex.mjs check --wait
```

远端采样另行显式请求；无授权、零样本或请求失败都不能当作通过：

```bash
node bin/exocortex.mjs check --live
```

服务已停止而希望保持停止时，只运行默认 `check`。没有 `check --restart`、`check --all` 或隐藏的构建/重启配方。需要等待后同时验证固定目标和样本，可以组合 `check --wait --through "$COVERAGE_TARGET_ISO" --live`；终点固定，等待失败后不继续远端采样或写缓存。

### 业务数据维护

`maintenance init` 和 `maintenance backup` 是明确写操作。其他维护动词默认预览，审阅后加 `--apply` 才写；enrich/replay 的预览仍会读取有界远端数据，不能当作离线模拟。记录和 scope 补全必须明确目标，没有隐式 all：

```bash
node bin/exocortex.mjs maintenance enrich --target scopes --limit 50
node bin/exocortex.mjs maintenance enrich --target scopes --limit 50 --apply
node bin/exocortex.mjs maintenance enrich --target records --limit 100 --probe-apps
node bin/exocortex.mjs maintenance enrich --target records --limit 100 --probe-apps --apply
```

远端解析发生在锁外，实际提交才取短维护锁并在同一事务内复查 lease、原快照和 CAS。维护锁使 worker 跳过当前写步骤，不制造 failed run；已有 sync lock 时维护操作失败并提示稍后重试。初始化需要 schema 前独立锁，不套用尚不存在的维护表。

常规备份和预览：

```bash
node bin/exocortex.mjs maintenance backup
node bin/exocortex.mjs check --latest-backup
node bin/exocortex.mjs maintenance prune-runs
node bin/exocortex.mjs maintenance compact
```

确认计划后再对相应动作加 `--apply`。连续锁冲突或较长修复可先显式 stop，检查无独立同步后维护，完成再 start 和 `check --wait`。维护锁有 TTL，正常退出释放；过期只是恢复条件之一，不证明 owner 已死。

## Public-Safe Command Output

这个仓库按 public 项目维护，但本地 runtime 数据是私有记忆。因此 terminal 输出分两类：

```text
product output      为本机使用者展示真实消息，例如 messages。
diagnostic output   为维护、验收、排障展示系统状态。
```

`node bin/exocortex.mjs messages --limit 20` 是产品阅读命令，会显示本地消息内容、群名和人员名。它的输出默认不适合复制到公开 issue、文档或 CI 日志。

诊断与维护默认只展示状态、计数、时间和有限原因，不输出真实身份、姓名、正文或原始错误 payload：

```bash
node bin/exocortex.mjs status
node bin/exocortex.mjs status --detail --format json
node bin/exocortex.mjs check
node bin/exocortex.mjs check --live
node bin/exocortex.mjs maintenance enrich --target records
node bin/exocortex.mjs maintenance enrich --target scopes
```

`status --logs --lines 20` 是显式私有日志读取，帮助和输出都标为 private。默认 status JSON 不暴露 launchctl 原文、内部 cache_path 或原始报告。

少数命令支持显式打开本地明细：

```bash
node bin/exocortex.mjs check --live --unsafe-details
node bin/exocortex.mjs maintenance enrich --target records --unsafe-details
```

`--unsafe-details` 的含义是：输出可能包含真实本地 ID、群名、人名、应用名、消息片段或远端错误细节，只能用于本机临时排障，不要复制进公开仓库、CI artifact 或聊天记录。

## SQLite Private Durability

候选版本的 backup v2 manifest 绑定源库身份；保留清理只处理经过验证且属于该源库的备份，不扫描删除同目录任意 SQLite。无归属信息的 legacy 备份不参与自动清理或 latest 选择，只能显式 `check --backup <path>` 验证。Records/scopes 富化使用条件写入，快照已变化时记录冲突而不覆盖新状态。富化默认预览不写库，但仍可能调用只读远端 API，不是离线模拟。

本地 SQLite 是当前衍我的私有记忆库。同步链路健康之后，需要定期确认它本身没有损坏，并且能生成可验证的本地备份。

这不是日常三命令，也不进入默认 help。需要时从完整目录查看：

```bash
npm run help -- --all
```

当前维护入口：

```bash
node bin/exocortex.mjs check
node bin/exocortex.mjs maintenance backup
node bin/exocortex.mjs check --latest-backup
node bin/exocortex.mjs maintenance prune-runs
node bin/exocortex.mjs maintenance compact
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

`check --latest-backup` 会打开最新同源备份，重新跑 integrity / foreign-key check，并核对该快照自己的 manifest、SHA-256、大小和计数。它不再把历史快照和持续变化的当前数据库比较，因此当前库后来新增消息不会让有效旧备份误报失败；备份内容即使保持行数不变，只要发生变化也会被 hash 检出。没有 manifest 的旧备份会明确报告为不可验证，而不是冒充验证成功。显式 `check --backup <path>` 在源库缺失或损坏时仍独立校验副本；源库失败使总体退出 1，但不抹去 `checks.backup` 结果。legacy v1 有效副本可显式验证，归属不能证明时为 unknown，不进入 latest 或同源清理。输出只包含状态、相对路径、计数和校验结果，不展示消息内容、人名、群名、链接或 raw payload。

`prune-runs` 用来控制 `sync_runs` 的长期增长。规则保持简单：

```text
删除 14 天前、没有造成 durable record insert/update 的 succeeded runs。
```

也就是处理空轮询和 duplicate-only 轮询，但必须同时满足：没有写入、没有更新，且没有被任何 scope 当作 `last_success_run_id` 引用。它不删除 `running`、`failed`、`cancelled`、有实际数据变化的成功 run，或当前 scope 引用的最新成功 run。后台 worker 默认每 1440 个 cycle 自动执行一次该保留策略，避免运行历史再次无限增长。

默认只预览：

```bash
node bin/exocortex.mjs maintenance prune-runs
```

确认候选数量合理后，才显式执行：

```bash
node bin/exocortex.mjs maintenance prune-runs --apply
```

`prune-runs --apply` 只删除运行日志，不删除 `records` 消息事实，也不推进或修改 cursor。它会通过全局 maintenance lock 和后台同步写入互斥；如果正好有 active sync lock，稍后重试即可。删除后的空闲页不会自动缩小文件；需要实际回收空间时，显式运行 `node bin/exocortex.mjs maintenance compact --apply`，该动作同样受 maintenance lock 保护。

SQLite 数据库、WAL/SHM、备份、worker 日志和 live probe cache 都属于私有运行数据。写路径负责私有权限初始化；默认诊断和缓存读取不 chmod。显式缓存写入使用 `0700` 目录及 `0600` 文件。LaunchAgent 同时配置 `Umask=63`；worker JSONL 按 10 MiB 轮转并默认保留 5 个历史文件，launchd stdout 指向 `/dev/null`，避免和 `worker.jsonl` 重复落盘。

## When Something Looks Wrong

先看总状态：

```bash
node bin/exocortex.mjs check
```

如果想对比远端热消息：

```bash
node bin/exocortex.mjs check --live
```

如果 `--live` 显示 `UNAVAILABLE / keychain_unavailable`，说明当前 shell 读不到 keychain。它不是同步系统故障，但采样不可用或失败使 check 整体非零退出；本地 health 证据仍单独保留。需要真实 live 验证时，在能访问 keychain 的普通终端环境里运行同一个命令。

新增自动化测试输入必须从零构造，使用假 CLI 与临时数据库；真实运行数据及其脱敏派生样例不得作为测试输入。

### Unsupported Chat Scopes

公共 status 在 Coverage 中显示 `Restricted chats`：单原因与总数同行，多原因逐行保留数量与非空错误码；公共 JSON 仍保留原有 unsupported 原因分组。

Received chat scope 的列表读取可能进入 unsupported 状态。它表示同步器识别到当前 lark-cli 身份不能读取会话列表，后续会暂停这个 scope，但本地已同步的 records 会保留。单条合并转发的详情失败不证明整个会话不可读取，不会禁用 scope。

候选修复不会自动重启用历史已被禁用的 scope；纠正已有运行数据需另行确认原因并授权，不属于代码升级的隐式动作。

当前已知原因：

- `bot_user_out_of_chat`：lark-cli 返回 `230002` / `Bot/User can NOT be out of the chat.`。同步器不推断用户是退群、被移出，还是切换身份；只按 lark-cli 的实际返回记录。
- `restricted_mode`：飞书返回保密模式/不允许复制转发一类错误。

这些 scope 不应该让 worker 每轮失败。它们会出现在 `node bin/exocortex.mjs status` 和 `node bin/exocortex.mjs check` 的 unsupported reasons 中，用于诊断。

看后台服务：

```bash
node bin/exocortex.mjs status
```

`status` 按四个区域展示信息；`--detail` 另补 Diagnostics：

```text
Health & current work -> 本地同步健康、后台服务与已验证的当前工作
Coverage              -> 消息、会话进度、内容欠账、名单状态与远端样本
Attention             -> 需处理项、可选采样及沿用同一目标的诊断提示
Recent history        -> 日志中的完成轮次、已完成任务及有限失败摘要
```

### Data Quality

Sender name quality 分三类：

- actionable sender gaps：用户 sender 缺名，或应用 sender 还没有被 resolver 判定为无法安全解析。它们使 `check` 的 quality 分项不能通过。
- system senderless messages：飞书系统消息天然可能没有 sender，不算同步故障。
- unresolved app sender names：官方应用 API 无权限，且会话机器人列表无法唯一匹配时，不强行猜名字；保留 unresolved 标记，作为质量报告里的 advisory。

看最近 worker 日志：

```bash
node bin/exocortex.mjs status --logs --lines 20
```

重启后台服务：

```bash
node bin/exocortex.mjs service restart
```

重启后等待一个完整成功 cycle：

```bash
node bin/exocortex.mjs check --wait
```

## Acceptance Check

候选代码需独立部署验收。

开发检查先在隔离 checkout 运行 `npm run verify`。部署后另在授权环境执行本地、新周期、固定目标和可选远端验收：

```bash
node bin/exocortex.mjs check
node bin/exocortex.mjs check --wait
node bin/exocortex.mjs check --through "$COVERAGE_TARGET_ISO"
node bin/exocortex.mjs check --live
node bin/exocortex.mjs messages --limit 20
node bin/exocortex.mjs status --detail
```

预期：

- 测试和检查通过。
- `check` 的 database/sync/quality 均通过；unknown、欠债、catching_up 或质量问题不能作为验收完成。
- 固定终点的 coverage-check 确认成功窗口连续覆盖，单次成功 cycle 不足以证明完整。
- `check --live` 获得非空、窗口明确、无 missing 的样本；全空、不可用和错误均不能算远端通过。
- 如需 service 展示样本，显式写缓存并在五分钟内检查 SAMPLED 及范围，当前认证主体仍未知。
- `status --detail` 中 `Conversation list`、`Active chat refresh`、`Chat list review` 分别能看出 initial、hot 和周期复核状态。
- `status` 的 `Recent history` 显示日志中最近完成的轮次；当前是否同步须查看 `Health & current work`，不能用历史推进替代当前阶段证据。
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

worker 默认仍使用固定批量；显式 `--adaptive-fair` 才启用自适应。前台 worker 与 `service install` 使用相同默认值、正整数及参数关系校验；以下参数可用于任一入口：

```sh
--received-scopes-per-cycle 25 --interval-seconds 30 \
--adaptive-fair --adaptive-fair-min 10 --adaptive-fair-max 50 \
--adaptive-target-cycle-seconds 90
```

目标周期包括实际工作和休眠。连续两个完整健康周期后最多加 5，并按已观测的 fair 每 scope 耗时和其他步骤耗时限制下一轮预算；失败、已暴露的限流、超时或重试耗尽会减半，最低为 `--adaptive-fair-min`（默认 10）。缺少统计不能作为提速依据。它是吞吐/延迟控制，不是 QPS limiter；成功也不证明 CLI 内部没有限流。

`summary.transport` 的 calls/attempts/retries 是外层 CLI 命令计数，不是 HTTP 请求数。worker 的 scheduler 事件记录有效批量、下一批量、决策原因和耗时。正常摘要以及出错时的专用 transport 摘要都保留脱敏计数和操作冷却，不写远端正文、token 或真实资源 ID。

调整 LaunchAgent 前应停止单实例、检查子进程退出、用 SQLite 原生 backup 保存独立副本，并备份当前代码及 plist。`service install` 将共同配置及 adaptive 开关、min、max、target 写入 plist；`start/restart` 沿用已安装配置。重新 install 时应显式提供要保留的非默认参数。`--once` 与 `--max-cycles` 仅用于前台 worker，service 拒绝这两个参数，持久化白名单也不会包含它们。`service install --db` 固化后台数据库；`status --db` 与 `check --db` 仅覆盖诊断目标。部署后以新 PID、多个完整周期、只读数据库与固定目标覆盖检查验收。退化时恢复此次部署前代码和配置，**不要恢复旧数据库**，以免丢失部署期间的新记录与游标进度。

## 原始消息与有界回填

received 直接分页读取原生消息列表，显式请求 `only_thread_root_messages=false`；sent 先搜索 ID，再以 mget 严格核对全部详情。错误信封、缺详情、重复详情、循环分页 token 或不完整分页均使窗口失败，不推进游标。查询的秒级边界向外取整，最终记录按原始毫秒起止裁剪。search 时间按官方契约使用无小数秒的 ISO8601。

原始 `body.content`、`update_time`、root/parent/thread 关系进入 `raw_json`。正文是可重建投影，canonical 保留 `content_rendering` 状态与版本。卡片使用下述有界文本投影；图片和未知结构保留原始 JSON 并明确标注未完整渲染，不会凭空补用户姓名。合并转发的完整原生子项进入 `raw_api_expansions`，子项不冒充当前会话里的独立消息。

### 卡片阅读与原始数据契约

身份命名空间、内容语义、诊断与实现边界统一遵循 [卡片与身份投影设计](card-and-identity-projection.md)。

`messages` 的卡片阅读从已存 `raw_json` 构建展示结果，不联网、不执行按钮、不回写正文或 canonical，也不需要重同步。优先读取原生 `body.content`，解开外层 JSON 与 `json_card` 字符串；兼容旧 CLI 原始 `content`。不会把旧的格式化 fallback 或派生 canonical 正文猜成卡片原文。

人类文本输出按标题、副标题、段落、字段和导航按钮分行，卡片不再经过普通消息的 240 字符单行压缩；`br` 节点和独立块边界保留为实际换行，行内节点与尾部有语义的文本仍按原顺序展示。解析器只处理明确支持的文本与布局节点，包括 `property` 包装、选定语言的 `i18nContent` / `i18nElements`、常见文本/Markdown、分栏、字段、容器的 `extra` 和按钮。明确没有可用导航链接的动作按钮默认收起，不执行回调，完整节点仍保留在 raw；有安全 HTTP(S) 地址的导航按钮继续显示。导航链接支持直接字符串地址及原生 `link.url = {url: string}` 的明确包装；按钮的直接地址与 `multi_url` 中默认、桌面、iOS、Android 地址分别显示；未配置的平台槽可为空，非空无效值不能被其他有效链接掩盖。它是文本投影，不是完整飞书客户端：图片、图表、未知可见节点、无效链接和解析超限仍明确提示，不将原始 JSON 倾倒到文本界面。

人员提及只接受同条原始消息中明确且无歧义的对应。除了直接匹配 `mentions` 的 ID，还读取 `body.content` 包装中的 `json_attachment.at_users`：卡片原生引用通过 `at_users` 的自有字典键或条目的 `user_id` 对应 `mention_key`，再连接同条消息的 `mentions` 取姓名。缺失或冲突的映射保持未知，不按出现顺序、ID 前缀或相似姓名猜测，不使用其他消息、缓存或联网查询补充。只有未解析提及时，在原位置显示未知提及占位，JSON 中仍保留 `status=partial` 和 `reason=unresolved_card_mention`，不再重复追加整行通用说明；同时存在其他关键缺失时，仍显示相应说明。

`--format json` 保留已有 `body`、`canonical`、`raw`、对应 JSON 字符串与 `display.body` 的含义；卡片只新增 `display.card = {text, status, reason, version}`。展示版本为 3，旧记录 canonical 中的历史渲染版本不会被阅读命令改写。普通消息仍使用原有展示。新同步的卡片也调用同一解析器，派生正文和渲染元数据可以改善，但 source `raw_json`、content hash 与源版本不因文本投影变化而变化；同版本投影改善仍遵守已有入库比较规则。

按钮地址、Markdown 和裸链接只展示 HTTP(S) 的 origin/path，省略凭证、查询参数和 fragment 时明确标记；其他协议或无效地址显示安全说明，不自动发请求。链接扫描在任何姓名替换之前，先消费原始文本中完整的连续非空白 URL，再识别 URL 外的 Markdown；这条规则也适用于链接标签中的 URL。URL 内的提及形状只是地址数据，不能查询姓名或消耗提及展开预算。方括号、IPv6 主机及查询中的 Markdown 形状不会把地址切成普通正文或独立链接。Markdown 目标用有界括号扫描；若 URL 吞入疑似标签闭合符，则保留安全可读内容并标为部分解析，不拆开地址来恢复语法。扫描位置只向前移动，成功或失败都消费已经检查的目标。Markdown 目标只读原始值，不展开提及；普通正文和标签中的外部提及按原始 ID 解析。每个姓名作为独立值生成并缓存安全文本，姓名中的提及不递归展开，姓名和链接的生成结果只追加到输出，不能改变父文本的 URL、标签或目标语法。完整链接仍在私有 raw 中，JSON 输出也保留原始数据。路径和正文仍可能包含私密信息，这不是可公开分享的诊断输出。原用户应通过私有 JSON 原文查看必要的完整地址，不能将显示后的省略地址当作原链接。

解析的累计 JSON 字符串和待检查文本分别最多 256 Ki 个 UTF-16 单元，嵌套最多 24 层、节点访问最多 2048 次，输出含说明最多 16,000 个 UTF-16 单元。每份待处理文本及允许展开的姓名来源字符合计最多 256 Ki 个 UTF-16 单元。外部提及按完整姓名接受；预算不足时输出固定提及占位并标为不完整，不回写或拼接源文本。缓存姓名的终态投影，不先生成“提及次数 × 姓名长度”的完整中间字符串。超过累计输入预算的文本、姓名或地址整值省略并标明限制，不能在解析前截断 URL；只有完成链接投影后才截取最终展示。终端控制序列和其隐藏内容作为完整原始区间消费，不在里面解析提及或 Markdown；未闭合的控制字符串消耗剩余内容，不反复寻找结束符。文本清理与词法扫描复用同一控制区间规则，提及内部开始而越过结束标签的控制序列也不会因替换而暴露尾部；双向控制符同样移除。如果一份文本含可能改变字面结构的控制符，并且原文或清理后的文本含链接 scheme，则整份当前文本显示不支持说明，其他节点仍可阅读；因为删除控制符可能把凭证变成主机名，或只留下查询值。独立按钮地址含这些控制符也整值拒绝。普通无链接的控制文本继续清理，正常换行和制表符不触发此规则。超限明确标注不完整。限制只作用于投影，不删除已存原文。`--search` 仍匹配数据库中已有 body，读取时的卡片投影不会建立新索引或改变筛选语义。

### 卡片动作状态的读取边界

卡片视图显示已存原始快照中的可见内容，收起动作按钮不表示动作已完成。正常同步按 `create_time` 推进列表游标，不按 `update_time` 回查旧卡片；普通 `interactive` 卡片不进入合并转发详情队列，`--scope details` 不能用于刷新它们。本次没有新增卡片状态轮询，也不保证实时审批状态或与客户端当前视图一致。

状态不一致时，先核对同一条消息的本地 raw 是否包含目标可见状态，再检查 `display.card` 的投影与状态。经授权的单条只读 GET/mget 对比可用于区分原始快照变化与 API 视图差异；应使用同一身份和 `raw_card_content`，比较源版本、原文内容与投影，不把客户端显示、单个按钮标签或解析成功当作远端状态证明。一次限定单条消息的核查中，同身份 GET 与 mget 返回的卡片内容均与本地结构一致，API 快照没有提供客户端显示的处理状态。这只能说明该次读取没有相应证据，不能直接归因于本地解析遗漏，也不能推广为所有卡片的 API 行为；不同接口返回仍可能需要进一步核对。

有界回填仍使用 received 列表接口且只接受严格更高的数字版本。单条 GET 返回新内容不证明列表也已更新；同版本内容冲突会保留现状，因此不能承诺重跑回填必然刷新卡片。只读核查不改记录、游标或详情待办；后续写入和部署需要分别授权与验收。

### 列表覆盖与详情重试

正常同步分开提交列表覆盖与完整内容覆盖。完整 list/search/mget 分页返回普通消息和合并根；迁移 009 的 `lark_im_list_progress` 保存连续列表水位，`lark_im_detail_tasks` 保存每个根的原始描述、指纹、版本、尝试次数、下次重试时间及安全错误分类。普通消息、待办、列表水位与 run 元数据在同一租约和代际校验事务提交。列表本身不完整时全部不提交。详情失败不覆盖已入库的完整根，不禁用会话，也不回退列表水位；进程重启后继续从持久化水位读取普通消息。

有欠账时 `sync_scopes.cursor_json`、完整覆盖窗口和最近成功标记不前进；部分 run 仅发出 `list_window_*`，并明确 `list_complete=true/details_complete=false/window_complete=false`。全部待办解决后，事务将完整游标推进到已经连续扫描的列表水位，并发出 `coverage_mode=list_checkpoint_and_details` 的闭合证据。目标时间及之前仍有当前待办时，覆盖检查不得凭历史成功报告完成。状态报告公开 `details` 和 `list_progress` 的汇总；pending details 使 health 保持 `catching_up`，Service 和 `check --wait` 同样拒绝完整健康结论。

状态报告在同一只读 SQLite 快照内采集欠账、列表水位、records、scope、discovery、run 和 lock，Service health 与 `check --wait` 使用该一致报告。表结构预查只选择查询分支，最终快照再次核对结构与迁移标记；并发迁移或证据缺失时失败关闭，不把它解释为零欠账。报告是某一时点的快照，之后提交的写入会在下次报告中出现；不得拼接旧的零欠账与新提交的未完整水位。该诊断不初始化数据库、不执行恢复，也不修改业务数据。

每次成功列表提交后至多尝试一个到期详情根。详情有独立 30 秒总请求预算、50 页、1000 项、64 层上限，不进入列表二分；失败按每根 60 秒指数退避，上限 24 小时，无最大失败次数。已完成指纹收据避免包含式边界反复重开相同欠账；新版根重新排队，详情重试先验证权威当前根，拒绝身份变化、版本倒退、同版本冲突及未展开根。旧完整正文会一直保留到完整新版本可替换。

独立详情入口只处理持久化的到期待办，不重新抓取列表，并遵守退避：

```sh
node bin/exocortex.mjs sync --scope details --detail-limit 5
```

`--detail-limit` 默认 5、最大 20；可用 `--detail-scope <stored-scope-id>` 限定本地 scope。整次详情批次共享 30 秒请求预算，某个根失败后只要仍有预算就处理后续根；锁定 scope 不占实际任务名额，从最多 `max(3×limit, limit+20)` 个候选补位。持续锁竞争下，候选范围外的 scope 可能延期；非请求事务开销不包含在远端请求截止保证内。仍有欠账（包括尚未到期）时规范 sync 退出码为 2，不能将“本次无到期任务”解释为已完成。正常轮询也会自动重试，无需独立命令才能继续列表。此次实现不自动重新启用历史上已禁用的 scope。

每个列表窗口共享 180 秒请求预算。页数超限沿用分钟边界二分；只有整个列表窗口总时间预算耗尽时，正常同步才直接收缩到起点之后的首个分钟边界，并至多再试一次该最小前缀。单次普通网络超时、限流或权限错误不触发缩窗。最小前缀仍超限则失败且不推进列表或完整游标。worker 的 600 秒步骤上限仍有效，分页二分与姓名查询也占步骤时间，不保证每次运行都进展。有界回填及严格 `fetch*Messages` 路径仍要求整个窗口完整，不使用列表欠账提交路径。

### 姓名投影合并

同步入库和 `maintenance enrich --target records` 使用同一姓名合并规则。空值或失败的 lookup 表示 unknown，不能抹掉同一发送者、会话或会话对方的已知姓名与来源。明确的 `*_name_state=cleared`（对方姓名为 `chat_partner.name_state`）表示权威清空；普通空 lookup 不产生此标记，也不能复活已清空的姓名。来自 `scope_config` 或 `local_history` 的会话名只是历史证据，可填未知字段，不能覆盖已知姓名或显式清空；原始消息提供的新会话名可更新。同一规则同时用于同步与补全。身份变化时不继承旧身份的姓名。

常规 records 补全只将实际尝试、支持该身份类型、查询明确失败且全部 fallback 后仍未知的姓名目标计入 `unresolved_name_targets`，并返回部分完成（退出码 2）。失败按具体目标或请求批次归属，不能把一个失败扩散到其他联系人或会话。既有姓名、权威清空和成功 fallback 不计入该欠账；没有尝试、不支持或正常返回未知也不自动算作失败。对已有姓名的强制应用探测失败仍保留诊断计数，但可以退出 0；退出 0 不表示每次可选探测都成功。依赖或数据库结构缺失等无法执行的维护返回 1，并保留安全的结构化失败报告。

姓名属于可补全投影，`raw_json` 与 source content hash 仍保留原始内容语义。同 raw/hash/version 的未知姓名重放保持幂等；同版本解析得到姓名或改善投影仍可更新。合并不取消原有版本防回退和补全的并发比较检查。有界回填的严格更高版本规则保持独立。

旧游标覆盖仅证明成功扫描窗口连续，不能证明旧 CLI 展开策略没有漏消息。明确选样对账后，可在停止 worker、完成一致备份和显式迁移后执行：

```sh
node bin/exocortex.mjs maintenance replay --db data/exocortex.sqlite \
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

### 精确补全历史发送者

联系人与群成员请求由同一 `name-resolver.mjs` 实现，在线同步、常规 enrich 和 sender-only 模式共享 30-ID 批次、显式 page-size、localized_name 归一化、self seed 优先和失败重试语义。姓名若等于原消息的任一明确 ID alias，或远端响应自身的 ID，按未知处理，不抑制成员 fallback；这也适用于历史姓名占位的候选筛选。常规 enrich 保留其扫描范围、预览、诊断和事务提交；单次请求最多五秒，它仍可能包含许多批次。

单目标修复使用 `--sender-only --sender-id`，需提前从可信记录取得确切 open ID。以下示例中的变量由操作者设置，不从姓名或截图猜 ID：

```bash
node bin/exocortex.mjs maintenance enrich --target records --db "$DB_PATH" \
  --sender-only --sender-id "$TARGET_OPEN_ID" --limit 50
```

此预览会发起有界只读远端查询，不写业务数据或获取维护锁。默认最多 50、上限 100 条，先筛选匹配且缺名记录再截断；总远端预算 30 秒、每次最多五秒、最多三个群和五页。零候选不联网。报告区分 unresolved、预算/页数限制、更多候选与提交冲突，未完成返回非零，不能把 updated=0 当作已修复。若预览确有可靠姓名，加上 `--apply` 才是显式业务写入，需相应操作授权；只更新 sender 投影及必要身份类型，保留 raw/hash/source version/body。详情见 [共同设计](card-and-identity-projection.md)。
