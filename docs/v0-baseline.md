# Exocortex V0 / V0.1 Baseline

## 结论

截至 2026-06-16，衍我的飞书消息同步已经达到 v0 baseline：

```text
后台 worker 持续运行，初始 catch-up 完成，真实 live probe 通过。
```

这不是完整衍我，也不是语义层起点。它只代表第一块地基可用：

```text
可靠同步我发出的飞书消息，以及我收到的非免打扰会话消息到本地。
```

截至 2026-06-21，v0.1 runtime baseline 也已完成并再次验收：

```text
同步入口、同步执行、adapter、store、worker、诊断、messages 查看和 terminal 输出已经拆出稳定边界；
后台服务通过 LaunchAgent 长期运行；
CLI、测试、CI 和 live probe 都能验证当前事实流健康。
```

截至 2026-06-26，v0.1 closeout 完成：

```text
后台服务运行在最新 main；
Service / Health / Activity / Freshness 四层状态稳定；
最近 24 小时运行窗口没有失败 cycle；
live probe 验证最近远端热消息没有本地缺失；
SQLite 私有记忆库通过 integrity check，并能生成可验证本地备份；
public-safe 诊断边界、terminal 命令目录和 CI 都已验收。
```

v0.1 仍然不是完整衍我，也不是 UI 或语义层起点。它代表：

```text
飞书消息事实流已经进入可维护、可诊断、可恢复的 runtime baseline。
```

## 当前验收结果

最近一次 v0.1 验收命令结果：

```text
npm run check                           passed
npm run build:check                     passed
npm run typecheck                       passed
npm test                                passed
node scripts/doctor.mjs                 OK, or SYNCING only while worker is actively running
node scripts/doctor.mjs --live          OK in a shell with keychain access
node scripts/lark-im-quality.mjs        OK
node scripts/maintenance-check.mjs      OK after local checks and service wait-ok
node scripts/sqlite-maintenance.mjs check          OK
node scripts/sqlite-maintenance.mjs backup         OK, writes to ignored private backup dir
node scripts/sqlite-maintenance.mjs verify --latest OK
node scripts/messages.mjs --limit 5     renders latest local records without exposing internal mechanics
node scripts/lark-im-service.mjs status RUNNING / Health OK / Freshness VERIFIED
```

仓库文档不记录真实消息数量、真实会话规模、真实人员、真实群名或真实链接。需要查看当前私有运行指标时，在本机运行：

```bash
node scripts/lark-im-service.mjs status
node scripts/doctor.mjs
node scripts/doctor.mjs --live
```

当前本地同步状态应满足：

```text
records exist
sent records exist
received records exist
received scopes are enabled
received without cursor = 0
initial discovery complete
periodic reconcile complete
latest live probe missing = 0
latest live lag is acceptable
actionable sender gaps = 0
sqlite quick_check = ok
sqlite foreign key issues = 0
latest private backup verifies
```

历史失败仍保留在 `sync_runs` 中，这是事实记录。`OK_WITH_HISTORY` 只作为内部诊断事实存在；`lark-im-service status` 的主健康状态会把当前可用系统展示为 `OK`。worker 正在跑时出现 `SYNCING` 也只是当前活动，不等于当前故障。

当前已知 advisory：

- 飞书 system 消息可能天然没有 sender，不算同步故障。
- 个别 app sender 在官方 Application API 无权限、且会话机器人列表无法唯一匹配时，保持 unresolved，不强行猜名字。
- `lark-im-quality` 会显示这些 advisory，但只有 actionable sender gaps、缺群名、invalid body 等可修复问题会让 `doctor` 进入 `NEEDS ATTENTION`。

当前 public-safe 要求：

- README、docs、tests、CI artifact 和 Git history 不记录真实消息内容、真实人员、真实群名、真实链接、真实 ID 或真实运行规模。
- 诊断和维护命令默认只输出状态、计数、相对路径和脱敏原因。
- 产品阅读命令 `messages` 可以在本机显示真实私有消息，但输出不适合复制进公开仓库。
- 需要真实本地细节时必须显式使用 `--unsafe-details` 一类参数，并且只用于本机临时排障。

当前 SQLite 私有耐久性要求：

- 本地库能通过 `PRAGMA quick_check`。
- 本地库能通过 `PRAGMA foreign_key_check`。
- 关键表存在，且聚合计数可读取。
- 私有备份使用 SQLite 自身的一致性备份机制生成，不直接复制运行中的数据库文件。
- 最新备份能被重新打开、重新检查，并与当前库比较关键表计数。
- 备份目录必须保持 git ignored。

## V0 保证

### 本地优先

消息事实进入本地 SQLite：

```text
data/exocortex.sqlite
```

本地库保留：

- `raw_json`：原始飞书 payload。
- `canonical_json`：当前稳定解释。
- `body`：terminal 阅读用正文。
- `sync_runs`：同步尝试历史。
- `sync_scopes.cursor_json`：每个同步范围的进度。

### 同步范围

v0 同步：

- 我发出的飞书消息。
- 我收到的、来自非免打扰群聊/话题群/私聊的消息。

`sent_by_me` 主要来自消息搜索；同时，已同步会话的 per-chat 消息流会把当前用户自己发出的消息按 `sent` 写入本地，用来覆盖 sticker/image 等不稳定出现在搜索结果里的非文本消息。

当前发现机制：

```text
initial full discovery -> 建立非免打扰会话集合
hot discovery          -> 每轮扫描最近活跃会话
periodic reconcile     -> 定期完整复核会话集合
```

### Restart-safe

worker 停摆或重启后，不从“现在”重新开始，而是从每个 Scope 的持久化 Cursor 继续。

Cursor 只在以下动作同一事务成功后推进：

```text
远端窗口完整读取
records 幂等写入
sync_runs 标记成功
sync_scopes.cursor_json 更新
```

失败、中断、分页未读完、达到页数上限仍有更多数据，都不能推进 Cursor。

### Source-time precision

飞书 IM 用户态接口返回的 `create_time` 当前按分钟表达。

因此 message cursor 不能推进到秒级 `window_end`，而是推进到源时间能表达的分钟边界：

```text
source_time_precision = minute
```

同一分钟边界上的消息会被下一轮重放，依赖本地幂等写入去重。这不是粗糙 backfill，而是和数据源时间精度匹配的 cursor 语义。

### 幂等写入

`records` 使用：

```text
source_id + external_id
```

作为稳定身份。重复读取同一条消息只会更新同一条本地记录，不会制造重复消息。

### 名称解析

用户发送者优先使用联系人和群成员 API 解析。

应用发送者使用分层策略：

1. 官方 Application API。
2. 如果权限不足，降级到当前会话机器人列表。
3. 只有能直接匹配 app_id，或同一会话里只有一个待解析 app sender 且只有一个机器人候选时，才使用 fallback。

fallback 必须写入来源和置信度：

```text
sender_name_source
sender_name_confidence
```

当前历史 app sender 回溯结果：

```text
official application api path was attempted
permission-denied app ids were handled without failing the sync
fallback path resolved eligible app senders
ambiguous fallback remained unresolved instead of guessed
```

系统消息和无法安全解析的 app sender 分开处理：

```text
actionable sender gaps      -> 需要处理，会影响 doctor
system senderless messages  -> 飞书系统事件允许无 sender，不影响 doctor
unresolved app sender names -> 保留 unresolved 标记，不猜错名字，不影响 doctor
```

## V0.1 Runtime Architecture

v0.1 的重点是把已经验证过的同步能力整理成可维护 runtime 边界。

当前核心边界：

```text
src/core                    通用同步规则，包含 cursor/window/pagination 语义
src/storage/sqlite          本地持久化、run、record、lock、recovery
src/adapters/lark-im        飞书 IM adapter、消息解释、名称解析、sync runner
src/runtime/worker          worker cycle 纯逻辑
src/terminal                terminal 渲染 helper 和 source-specific view
src/diagnostics             doctor、sync status、quality、live lag 等诊断逻辑
src/cli                     production CLI command implementation
scripts                     稳定用户入口和兼容 wrapper
```

`scripts/lark-im-sync.mjs` 当前只保留稳定入口和兼容测试导出；实际 CLI 行为在：

```text
src/cli/lark-im-sync-command.mjs
```

同步执行在：

```text
src/adapters/lark-im/sync-runner.mjs
```

它通过 `createSyncRunner(deps)` 支持 fake deps 测试，因此成功路径和失败路径都能在不访问真实飞书、不访问真实 SQLite 的情况下验证。

诊断入口已经按 report / view / command 拆分：

```text
sync-status    diagnostics report + terminal view + CLI command
doctor         diagnostics report + terminal view + CLI command
lark-im-worker CLI command
               src/cli implementation + stable script wrapper
lark-im-service CLI command
               src/cli implementation + stable script wrapper
               status diagnostics report + terminal view
messages       diagnostics report + terminal view + CLI command
maintenance    release/maintenance validation command
sqlite         private durability check/backup/verify command
```

`messages` 是日常查看本地消息事实的核心入口。`scripts/messages.mjs` 保持稳定路径，内部已经拆成：

```text
src/diagnostics/messages-report.mjs
src/terminal/messages-view.mjs
src/cli/messages-command.mjs
```

它不做复杂查询体验，不进入语义层，只负责把最近同步到本地的 records 以可读方式展示。系统消息会显示为 `系统`，不会把 senderless system message 展示成 `unknown`。

`lark-im-service` 的安装、启停、重启和卸载仍通过稳定脚本路径调用；实现已经迁入 `src/cli`，LaunchAgent 路径不变。

当前测试重点覆盖：

- cursor 边界推进和同分钟重放。
- 分页完整性和 unsafe pagination failure。
- records 幂等写入。
- failed run 不推进 cursor。
- lock / stale lock / stale run recovery。
- Lark transport retry、rate limit backoff 和命令脱敏。
- sender/app/chat name resolution fallback。
- sync runner 成功、失败、locked、disabled、unsupported、batch limit。
- worker step 顺序和 cycle summary。
- worker CLI 外壳参数、子命令拼装、JSONL log、run loop 和 exit code。
- doctor/live probe 状态归一化。
- `lark-im-service` 参数、LaunchAgent plist、生命周期命令、worker log rendering 和 `wait-ok` readiness。
- `messages` 参数解析、SQLite 查询条件、私聊接收人、系统消息、text/json/error 输出。
- `live-probe` freshness cache 脱敏摘要。
- `lark-im-service status` 的 Service / Health / Activity / Freshness 四层状态、Last 24h runtime stability summary 和失败原因分类聚合。
- `maintenance-check` 的本地检查、服务 restart/wait-ok、doctor/live/status 编排和 public-safe failure summary。
- `sqlite-maintenance` 的 integrity check、private backup、latest verify、count mismatch failure 和 public-safe 路径输出。
- `sqlite-maintenance prune-runs` 的 dry-run 默认行为、旧 succeeded no-op run 清理规则、不删除 failed/running/current success 的边界，以及 apply 时默认拒绝和运行中的 worker 抢写 SQLite。
- terminal command catalog 和渲染。

## V0 不保证

v0 不建模：

- 已读。
- 免打扰会话里的 received 消息。
- 语义摘要。
- embedding。
- 任务/决策/项目识别。
- UI。

v0 也不保证所有显示名都来自一等官方名称接口。应用发送者在权限不足时允许有 provenance 的 best-effort fallback。

## 日常操作

只记三个命令：

```bash
npm run help
```

```bash
node scripts/messages.mjs --limit 20
```

```bash
node scripts/lark-im-service.mjs status
```

完整命令目录：

```bash
npm run help -- --all
```

## V0 / V0.1 验收命令

需要重新验收时运行：

```bash
npm run check
npm run typecheck
npm run build:check
npm test
node scripts/doctor.mjs
node scripts/lark-im-quality.mjs
node scripts/maintenance-check.mjs --live
node scripts/sqlite-maintenance.mjs check
node scripts/sqlite-maintenance.mjs verify --latest
node scripts/messages.mjs --limit 20
node scripts/lark-im-service.mjs status
```

如果当前 shell 可以访问 macOS Keychain，再运行真实远端对照：

```bash
node scripts/doctor.mjs --live
```

如果 `doctor --live` 显示 `UNAVAILABLE / keychain_unavailable`，只说明当前 shell 不能访问 lark-cli Keychain，不等于后台同步失败。

## Closeout 后的下一步

v0.1 closeout 之后，不急于进入 UI、语义层、新信息源或 v0.2。

当前进入观察和维护阶段：

1. 继续观察 worker 长期运行，定期运行 `doctor --live`。
2. 定期运行 `sqlite-maintenance check`，需要时生成并验证私有备份。
3. 维护期间使用 `maintenance-check` 做收尾验收，不把修复动作藏进验收命令里。
4. 保持当前 JS CLI command 边界稳定，不急着做 TypeScript production rewrite。
5. 只有在 v0.1 运行继续稳定、且下一阶段目标明确后，再讨论 v0.2。

v0.2 之前如果继续做工程工作，优先级应是：

1. 提升现有 terminal 阅读和诊断质量。
2. 修补真实运行中暴露的小问题。
3. 继续降低 public repo 隐私泄露风险。
4. 补齐已存在边界的测试，而不是扩展产品范围。
