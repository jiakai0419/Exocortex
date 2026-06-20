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

截至 2026-06-20，v0.1 runtime baseline 也已完成：

```text
同步入口、同步执行、adapter、store、worker、诊断和 terminal 输出已经拆出稳定边界；
后台服务通过 LaunchAgent 长期运行；
CLI、测试、CI 和 live probe 都能验证当前事实流健康。
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
node scripts/doctor.mjs                 fresh / syncing only when worker is active
node scripts/doctor.mjs --live          healthy in a shell with keychain access
node scripts/lark-im-quality.mjs        OK
node scripts/lark-im-service.mjs status ACTIVE
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
```

历史失败仍保留在 `sync_runs` 中，这是事实记录。当前健康状态使用 `OK_WITH_HISTORY` 或 worker 正在跑时的 `SYNCING`，不等于当前故障。

当前已知 advisory：

- 飞书 system 消息可能天然没有 sender，不算同步故障。
- 个别 app sender 在官方 Application API 无权限、且会话机器人列表无法唯一匹配时，保持 unresolved，不强行猜名字。
- `lark-im-quality` 会显示这些 advisory，但只有 actionable sender gaps、缺群名、invalid body 等可修复问题会让 `doctor` 进入 `NEEDS ATTENTION`。

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
lark-im-service status
               diagnostics report + terminal view
```

`lark-im-service` 的安装、启停、重启和卸载仍在稳定脚本入口中，避免把 LaunchAgent 写路径和纯状态展示混在一次迁移里。

当前测试重点覆盖：

- cursor 边界推进和同分钟重放。
- 分页完整性和 unsafe pagination failure。
- records 幂等写入。
- failed run 不推进 cursor。
- lock / stale lock / stale run recovery。
- Lark transport retry 和命令脱敏。
- sender/app/chat name resolution fallback。
- sync runner 成功、失败、locked、disabled、unsupported、batch limit。
- worker step 顺序和 cycle summary。
- worker CLI 外壳参数、子命令拼装、JSONL log、run loop 和 exit code。
- doctor/live probe 状态归一化。
- `lark-im-service` 参数、LaunchAgent plist、worker log rendering 和 `wait-ok` readiness。
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
node scripts/messages.mjs --limit 20
node scripts/lark-im-service.mjs status
```

如果当前 shell 可以访问 macOS Keychain，再运行真实远端对照：

```bash
node scripts/doctor.mjs --live
```

如果 `doctor --live` 显示 `UNAVAILABLE / keychain_unavailable`，只说明当前 shell 不能访问 lark-cli Keychain，不等于后台同步失败。

## 下一步

v0.1 baseline 之后，不急于进入 UI、语义层或新信息源。

建议顺序：

1. 继续观察 worker 长期运行，定期运行 `doctor --live`。
2. 不急着做 TypeScript production CLI rewrite；先保持当前 JS CLI command 边界稳定。
3. `sync-status`、`doctor` 和 `lark-im-service status` 已完成 report / view 边界拆分；`lark-im-service` 和 `lark-im-worker` 非破坏性 helper 已有测试护栏。如果继续重构，下一步优先观察这些诊断入口和 worker 外壳的稳定性，再评估是否把 worker CLI 外壳迁入 `src`。
4. 等同步、诊断和 CLI 边界继续稳定后，再考虑下一信息源或最小语义层。
