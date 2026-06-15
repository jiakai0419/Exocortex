# Exocortex V0 Baseline

## 结论

截至 2026-06-14，衍我的飞书消息同步已经达到 v0 baseline：

```text
后台 worker 持续运行，初始 catch-up 完成，真实 live probe 通过。
```

这不是完整衍我，也不是语义层起点。它只代表第一块地基可用：

```text
可靠同步我发出的飞书消息，以及我收到的非免打扰会话消息到本地。
```

## 当前验收结果

最近一次验收命令结果：

```text
npm run check                           passed
npm test                                passed
node scripts/doctor.mjs                 fresh / syncing only when worker is active
node scripts/doctor.mjs --live          healthy in a shell with keychain access
node scripts/lark-im-quality.mjs        OK
node scripts/lark-im-service.mjs status ACTIVE
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
```

历史失败仍保留在 `sync_runs` 中，这是事实记录。当前健康状态使用 `OK_WITH_HISTORY` 或 worker 正在跑时的 `SYNCING`，不等于当前故障。

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

## V0 验收命令

需要重新验收时运行：

```bash
npm run check
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

v0 baseline 之后，优先做长期运行观察，而不是立刻扩功能。

建议顺序：

1. 观察 24 小时 worker 持续运行情况。
2. 定期运行 `doctor --live`，确认远端热消息仍然能端到端进入本地。
3. 审计 P2P sent 消息的 `chat_partner`，确认“接收人”字段是否总是可靠。
4. 如果 24 小时稳定，再考虑下一阶段：是否纳入单聊 received，或进入最小语义层。
