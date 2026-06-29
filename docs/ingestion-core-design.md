# Ingestion Core Design

## 目标

衍我的信息同步内核负责一件事：

```text
把外部信息源中的事实，可靠地带入本地 Exocortex。
```

当前第一个信息源是飞书消息，但核心设计必须能扩展到文档、日历、邮件、会议纪要、浏览器和本地文件。

## 非目标

这个核心模块不负责：

- UI 展示。
- 摘要和语义理解。
- 项目识别。
- 任务抽取。
- 已读建模。
- 运维面板布局。

这些可以使用同步内核产生的数据，但不能反向决定核心抽象。

## 核心抽象

### Source

外部信息源。

例子：

```text
lark.im
lark.docs
lark.calendar
mail
browser
filesystem
```

Source 表示数据来自哪里，以及由哪个 adapter 负责读取。

### Scope

Source 下的一个同步范围。

例子：

```text
lark.im.sent_by_me
lark.im.unmuted_chat_discovery
lark.im.received.chat.<chat_scope_id>
lark.docs.touched_by_me
lark.calendar.my_events
```

Scope 是同步进度的基本单位。每个 Scope 独立维护 Cursor。

### Cursor

某个 Scope 在远端的同步进度位置。

Cursor 的具体语义由 Source Adapter 定义。它可能是：

- 时间戳。
- opaque token。
- page cursor。
- 版本号。
- 复合位置，例如 `{created_at, external_id}`。

核心层不解释 Cursor 的业务含义，但会执行 Source Adapter 明确声明的通用策略，例如：

- 时间 Cursor 的比较规则。
- 同一时间戳下的稳定 tie-breaker。
- stable horizon。
- 分页必须完整读完才算成功。
- 远端时间精度对应的 Cursor 边界。

也就是说：

```text
Adapter 定义 Cursor 语义
Core 执行可复用的同步规则
Store 原子保存 Cursor
```

这能避免每个 Source 都重新手写一套容易漏边界的同步规则。

### Record

从 Source 读取到的一条外部事实。

例子：

- 一条飞书消息。
- 一个日历事件。
- 一封邮件。
- 一个文档版本。
- 一条会议纪要片段。

Record 必须有稳定身份：

```text
source + external_id
```

没有稳定身份的外部数据不能直接作为普通 Record 进入核心同步流，需要单独设计去重策略。

### Run

一次同步尝试。

Run 记录：

- 同步哪个 Source / Scope。
- 开始时间。
- 结束时间。
- cursor_before。
- cursor_after。
- 扫描了多少 Record。
- 写入了多少 Record。
- 跳过了多少重复 Record。
- 成功或失败。
- 错误信息。

Run 是事实记录，不是 UI 概念。

## Restart and Recovery Contract

同步系统必须假设 worker 会在任意时刻停止：

- 机器睡眠。
- 进程崩溃。
- 网络断开。
- `lark-cli` 临时不可用。
- LaunchAgent 被重启。
- Codex 或人工中途改配置。

因此，任何 Source Adapter 都必须满足下面的恢复契约。

### 持久化状态是唯一真相

重启后不能依赖内存里的队列、计数器、分页进度或上一次日志。

worker 必须只从本地持久化状态恢复：

```text
sync_scopes.cursor_json
sync_scopes.config_json
sync_runs
sync_locks
records
```

如果某个状态没有持久化，就不能作为不漏消息的依据。

### Cursor 只能在原子提交中推进

一个 Scope 的 Run 只有在以下动作同时成功后，才能推进 Cursor：

```text
远端窗口完整读取
records 幂等写入
sync_runs 标记成功
sync_scopes.cursor_json 更新
```

这些动作必须在同一事务里提交。进程在事务前或事务中崩溃时，下次重启只能重新读取旧窗口；允许重复读取，不允许跳过未确认数据。

### 失败和中断不能制造前进

以下情况不能推进 Cursor：

- API 分页没有读完。
- `has_more=true` 但没有下一页 token。
- 达到安全页数上限仍未读完。
- 内容解析失败到无法确定 Record 身份。
- 进程被杀或机器睡眠导致 Run 没有正常结束。

失败 Run 是诊断事实，不是同步进度。

### 重启后必须能继续上次的点

对于消息类 Scope：

```text
start = 上次持久化 Cursor
end = 当前时间的稳定边界
```

Adapter 必须从 `start` 重新读，并在本地过滤严格大于 Cursor 的 Record。这样即使 `start` 是包含式，重启后也只会重复读取已确认边界，不会漏掉边界之后的消息。

如果远端 API 的时间精度低于本地时间精度，Cursor 必须推进到远端能表达的边界，而不是推进到本地秒级或毫秒级窗口终点。

飞书 IM 用户态接口当前返回分钟精度的消息时间，因此它的消息 Cursor 使用：

```text
source_time_precision = minute
created_at_ms = floor(window_end, 1 minute)
message_id = ""
```

同一分钟边界的消息允许在下一轮重复读取，依赖 `records` 幂等写入去重。这是 Cursor 语义的一部分，不是靠模糊 backfill 补漏。

对于分页发现类 Scope：

```text
has_more=true  -> 用持久化 page_token 继续同一个 snapshot
has_more=false -> 该 snapshot 已完成
```

未完成 snapshot 重启后必须继续扫后续页，不能从第一页重新开始后直接覆盖状态。

### 锁和 running Run 必须可回收

`sync_locks` 只表示“可能有 worker 正在处理这个 Scope”，不能成为永久状态。写库维护使用独立的全局 `maintenance_locks`，不复用 per-scope lock。

要求：

- 锁必须有 TTL。
- 新 worker 抢锁时必须清理过期锁。
- 旧进程已不存在时，stale lock 和对应 running Run 必须能被标记为 cancelled 或 failed。
- 健康状态应区分“真实正在同步”和“疑似 stale lock”。

维护锁规则保持简单：

- 只允许一个全局维护锁：`name = global`。
- 维护锁存在时，worker sync step 跳过本轮，不创建 failed Run。
- 维护命令获取维护锁时，如果已有 active `sync_locks`，直接失败并提示稍后重试或手动停止 worker。
- 维护锁只用于写库维护，例如 enrichment、repair、`prune-runs --apply`；只读诊断不需要锁。
- 不引入队列、优先级或多种 lock mode。

### 恢复优先级

长时间停摆后重启，worker 的优先级是：

1. 先推进已知 Scope 的消息 Cursor，补齐停摆期间的消息。
2. 同时执行 hot discovery，发现最近活跃的新会话。
3. 对未完成的 full discovery snapshot 继续分页。
4. 周期性执行 full reconcile，重新确认完整非免打扰会话集合。

其中第 4 点不能混同于初始 catch-up。初始 catch-up 完成后，系统可以是健康的；后续 full reconcile 是维护“范围集合正确性”的后台盘点，不应该把主健康状态打成长期 catching up。

### 不漏消息的边界

对已经有 Scope 和 Cursor 的消息范围，系统必须保证：

```text
长时间停摆后重启，不跳过 Cursor 之后的消息。
```

对尚未发现的新会话，系统的保证来自 discovery 策略：

- hot discovery 负责近实时发现最近活跃会话。
- periodic full reconcile 负责发现冷门会话、免打扰状态变化、会话列表排序变化。

如果缺少 periodic full reconcile，只能声称“活跃新会话可被发现”，不能声称“所有新会话长期一定被发现”。

## 存储角色

核心概念里不单独引入 Ledger。

本地 `records` 表承担事实账本的角色：

```text
records = persisted collection of Records
```

换句话说：

- `Record` 是领域对象。
- `records table` 是持久化账本。

不需要把 Ledger 作为一个和 Record 并列的核心概念。

## 正确性约束

### 1. Scope 独立推进

每个 Scope 独立同步、独立维护 Cursor。

一个 Scope 失败不能影响另一个 Scope 的进度提交。

### 2. 写入幂等

Record 写入必须幂等。

唯一键：

```text
source + external_id
```

重复读取同一条外部事实，只能更新同一条本地记录，不能制造重复记录。

### 3. Cursor 原子提交

同一轮 Run 中：

```text
Record 写入
Cursor 推进
Run 状态更新
```

必须在同一个事务语义下完成。

如果 Record 已写入但 Cursor 未推进，下轮重复读取是允许的，因为写入幂等。

如果 Cursor 推进但 Record 没写入，就是数据丢失。这是不允许的。

### 4. 失败不推进

Run 失败时不能推进 Cursor。

下次同步必须从旧 Cursor 继续。

### 5. Adapter 负责远端语义

核心层不猜远端分页、排序和 Cursor 规则。

每个 Source Adapter 必须明确声明：

- 如何列出 Scope。
- 如何从 Cursor 后读取 Record。
- 远端返回是否有稳定顺序。
- Cursor 何时可以安全推进。
- 远端时间或版本号的精度。
- 分页是否需要完整读完才算一个成功 Run。

### 6. 不靠补漏保证正确

同步正确性来自：

```text
Cursor + ordered scan + idempotent write + atomic commit
```

不是来自周期性补洞。

如果未来发现某个 Source 的边界条件需要保护，例如远端时间排序有轻微延迟，只能引入明确、有限、可解释的 boundary guard。它不能成为主正确性机制。

飞书消息同步当前采用 `stable horizon` 作为这种 boundary guard：

```text
implicit_now_end = now - stable_horizon
```

也就是说，自动轮询不会把消息 Cursor 直接推进到当前瞬间，而是只推进到一个已经稳定的时间水位线。手动指定 `--end` 时不应用这个水位线，便于明确的历史窗口验证。

## 推荐数据模型

### `sources`

```text
id
kind
display_name
enabled
config_json
created_at
updated_at
```

例子：

```text
id: lark.im
kind: lark
display_name: Lark Messages
```

### `sync_scopes`

```text
id
source_id
name
description
enabled
config_json
cursor_json
cursor_updated_at
last_success_run_id
last_error_run_id
created_at
updated_at
```

例子：

```text
id: lark.im.sent_by_me
source_id: lark.im
name: sent_by_me
```

### `records`

```text
id
source_id
first_seen_scope_id
external_id
external_version
record_type
occurred_at
occurred_at_ms
received_at
actor_id
container_id
direction
title
body
content_hash
canonical_json
raw_json
created_at
updated_at
```

唯一约束：

```text
unique(source_id, external_id)
```

`first_seen_scope_id` 只表示这条 Record 第一次由哪个 Scope 摄入，不表示 Record 只能属于这个 Scope。Scope 是同步进度边界，不是事实归属边界。

这里的 `direction` 是可选的通用字段。对消息类 Record，它可以是：

```text
sent
received
```

对非消息类 Record，可以为空或使用该 source 自己的语义。

### `sync_runs`

```text
id
source_id
scope_id
status
cursor_before_json
cursor_after_json
started_at
finished_at
scanned_count
inserted_count
updated_count
duplicate_count
error_type
error_message
metadata_json
```

`status`：

```text
running
succeeded
failed
cancelled
```

### `sync_locks`

```text
scope_id
locked_by
locked_at
expires_at
```

用于防止同一个 Scope 被多个 worker 同时同步。

### `maintenance_locks`

```text
name
owner
acquired_at
expires_at
reason
```

用于防止写库维护和后台同步同时写 SQLite。当前只使用一个全局锁：

```text
name = global
```

## Source Adapter 接口

概念接口：

```text
listScopes() -> Scope[]
read(scope, cursor) -> SyncPage
commit(scope, nextCursor) -> void
```

其中 `SyncPage`：

```text
records: Record[]
next_cursor: Cursor
has_more: boolean
is_checkpointable: boolean
```

当且仅当 adapter 确认当前读取范围已经完整处理，才允许 `is_checkpointable = true`。

## 飞书消息映射

### Source

```text
lark.im
```

### Scopes

```text
lark.im.sent_by_me
lark.im.unmuted_chat_discovery
lark.im.unmuted_chat_hot
lark.im.unmuted_chat_reconcile
lark.im.received.chat.<chat_scope_id>
```

### `sent_by_me`

语义：

```text
我发出的飞书消息
```

读取路径：

```text
lark-cli contact +get-user --as user
  -> self open_id
  -> lark-cli im +messages-search --as user --sender <self_open_id>
```

Cursor 注意事项：

- `+messages-search` 已验证不能假设返回顺序按 `create_time asc`。
- Adapter 必须使用有上界的时间窗口，例如 `[cursor_time, run_started_at]`。
- 只有窗口内分页完整读完，才允许本地排序、写入、推进 Cursor。
- 如果分页达到上限但仍有 `has_more=true`，本轮必须失败或拆小窗口，不能推进 Cursor。
- `--start` 边界表现为包含式，因此下轮可以从 cursor timestamp 重新读取，并在本地过滤严格大于 `{created_at_ms, message_id}` 的记录。

Record 映射：

```text
external_id: message_id
record_type: lark.im.message
direction: sent
actor_id: sender open_id
container_id: chat_id
occurred_at: create_time
body: content
raw_json: full message JSON
```

应用发送者名称：

飞书消息中的应用发送者通常表现为：

```json
{
  "sender": {
    "id": "cli_xxx",
    "id_type": "app_id",
    "sender_type": "app"
  }
}
```

`cli_xxx` 是应用 app_id。解析应用名称必须使用一等应用信息接口：

```text
GET /open-apis/application/v6/applications/:app_id
params: { "lang": "zh_cn" }
token: tenant_access_token
```

该接口需要应用具备“获取应用信息”相关权限，例如 `admin:app.info:readonly`。如果权限不足，系统允许降级到会话机器人列表做 best-effort 推断，但必须满足两个条件：

1. 如果机器人列表返回可直接匹配的 app_id，才视为高置信度。
2. 如果无法直接匹配，只能在“同一会话里只有一个待解析 app sender，且只有一个机器人候选”的唯一场景下使用中置信度 fallback。

fallback 结果必须写入来源和置信度，例如 `sender_name_source=chat_bot_unique`、`sender_name_confidence=medium`。多机器人群、多个待解析 app sender、或机器人列表不可用时不能猜，必须保留 app_id 并让质量检查暴露缺口。

### `unmuted_chat_discovery`

语义：

```text
发现当前非免打扰会话
```

读取路径：

```text
lark-cli im +chat-list --as user --exclude-muted --types group,p2p
  -> paginate with page_token cursor
  -> create or enable one received message Scope per chat
```

注意：

- `--exclude-muted` 是逐页过滤；某一页可能返回 0 个非免打扰会话但仍然 `has_more=true`。
- 因此发现阶段不能只看第一页。
- 发现阶段本身也是一个可恢复的分页同步：每次处理有限页，把 `page_token` 存进 `unmuted_chat_discovery` 的 Cursor。
- 只有当一个发现快照完整扫到 `has_more=false` 时，才禁用本轮未再出现的旧 chat scope。
- 扫描未完成时，已经发现的 chat scope 可以先同步；未发现的后续页会在后续 discovery run 中补上。

Discovery 分成三种职责，不能混为一个状态：

```text
initial full discovery
hot discovery
periodic full reconcile
```

`initial full discovery` 是第一次建立完整非免打扰会话集合。它会影响初始 catch-up 状态。

`hot discovery` 每个 worker cycle 扫最近靠前的会话页，用来尽快发现最近活跃的新会话。它不推进 full discovery Cursor，也不能替代完整会话盘点。

`periodic full reconcile` 是长期维护机制：定期重新开始一个完整 discovery snapshot，扫到 `has_more=false` 后再更新完整集合，并禁用本轮未出现的旧 chat scope。它用于处理长时间停摆、新冷门会话、会话免打扰状态变化、远端排序变化等情况。它有独立的 `lark.im.unmuted_chat_reconcile` Scope，不覆盖 initial discovery Cursor，不应该把已经完成初始同步的系统长期标记为 `CATCHING UP`。

当前代码已经有 `initial full discovery`、`hot discovery` 和第一版 `periodic full reconcile`。

- `initial full discovery` 使用 `lark.im.unmuted_chat_discovery`，完成后保留第一次完整快照的 Cursor。
- `hot discovery` 使用 `lark.im.unmuted_chat_hot`，每轮扫描靠前会话页，只记录最近运行状态，不覆盖 initial full discovery Cursor。
- `periodic full reconcile` 使用 `lark.im.unmuted_chat_reconcile`，默认间隔为 24 小时；未到期时快速跳过，已开始但未完成的 reconcile snapshot 会从持久化 `page_token` 继续。

### `received.chat.<chat_scope_id>`

语义：

```text
某一个非免打扰会话里，别人发给我的消息
```

Scope config:

```json
{
  "chat_id": "oc_xxx",
  "chat_type": "group"
}
```

读取路径：

```text
lark-cli im +chat-messages-list --as user --chat-id <chat_id> --order asc
  -> filter sender_id != self_open_id
```

Record 映射：

```text
external_id: message_id
record_type: lark.im.message
direction: received
actor_id: sender open_id
container_id: chat_id
occurred_at: create_time
body: content
raw_json: full message JSON
```

Cursor 注意事项：

- `+chat-messages-list --order asc` 已验证在样本内按 `create_time` 单调递增。
- `--start` 边界表现为包含式。
- 飞书 IM `create_time` 在当前用户态接口中按分钟返回；message cursor 只能推进到分钟边界，不能推进到秒级 `window_end`。否则后到但仍显示为同一分钟的消息会被本地 cursor 过滤掉。
- 每个 chat Scope 独立维护 Cursor，不能用一个全局 received cursor 代表所有群。
- Adapter 读取时从 cursor timestamp 开始，写入前本地过滤严格大于 `{created_at_ms, message_id}` 的记录。
- cursor 的 `message_id` 保持为空字符串，允许同一分钟边界消息在下一轮重放；重复记录由 `(source_id, external_id)` 幂等约束消化。

## 飞书 Cursor 设计

当前 `lark-cli` 没有暴露类似 Microsoft Graph delta token 的 IM 消息变更 token。

因此飞书消息 adapter 需要基于时间窗口、分页完成语义和本地幂等写入设计 Cursor。

候选 Cursor：

```json
{
  "created_at_ms": 1781337300000,
  "message_id": "om_xxx"
}
```

通用推进规则：

- 同一时间戳内使用 `message_id` 作为 tie-breaker。
- 只有分页完整处理后，才推进到本轮最大 `{created_at_ms, message_id}`。
- 下轮读取严格大于 Cursor 的消息。
- 写入和 Cursor 推进必须在同一事务提交。

各路径差异：

- `sent_by_me` 使用 `+messages-search`。该接口样本中不是按 `create_time asc` 返回，因此必须完整读取有上界窗口，再本地排序和过滤。
- `received.chat.<chat_scope_id>` 使用 `+chat-messages-list --order asc`。该接口样本中按 `create_time` 单调递增，适合 per-chat cursor。
- 两条路径的 `--start` 边界样本中都是包含式，因此 adapter 必须本地过滤严格大于 Cursor 的记录，而不是假设远端支持严格大于。

### Unsupported received chat scopes

某个 `received.chat.<chat_scope_id>` 可能在历史上可同步，之后变成不可同步。处理原则：

- 已同步 records 保留。
- 不把不可同步 scope 的每轮失败当作 worker 整体故障。
- 不用 UI 或业务猜测命名原因；按 source adapter 实际观察到的远端/lark-cli 返回记录。

当前 Lark IM adapter 识别的原因：

- `bot_user_out_of_chat`：lark-cli 返回 `230002` / `Bot/User can NOT be out of the chat.`。
- `restricted_mode`：飞书返回保密模式/不允许复制转发一类错误。

识别后，scope 写入 `config_json.unsupported_reason`、`unsupported_at`、`unsupported_error`，并设置 `enabled = 0`。如果后续需要恢复，应通过显式 recheck/re-enable 流程处理，而不是由 hot discovery 自动打开。

## 设计原则

1. 核心抽象不由 UI 倒推。
2. 正确性优先于实时性。
3. 重复读取可以接受，重复入库不可以。
4. 失败可以接受，错误推进 Cursor 不可以。
5. Source-specific 逻辑留在 Adapter，核心层只处理通用同步语义。
6. 不确定的远端语义必须显式标记为待验证，不能被隐藏在代码里。
