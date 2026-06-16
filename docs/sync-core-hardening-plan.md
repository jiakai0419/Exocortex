# Sync Core Hardening Plan

## 当前判断

衍我当前阶段的核心不是 UI、摘要、embedding 或新信息源，而是把飞书消息同步做成可以长期依赖的事实流。

现状：

- 后台 worker 已经能持续运行。
- 本地 SQLite schema 已经有 Source / Scope / Record / Run / Lock。
- Terminal-first 已经成为交互原则。
- `npm test` 已经覆盖了一部分 cursor 和事务语义。
- 但 `scripts/lark-im-sync.mjs` 仍然过大，混合了 CLI adapter、同步编排、SQLite store、消息转换和错误处理。

因此下一阶段目标是：

```text
把消息同步从“能跑”推进到“可信、可测试、可维护、可长期运行”。
```

## 非目标

当前不做：

- UI。
- 语义层、摘要、embedding。
- 新 Source 接入。
- 更复杂的产品查询体验。
- 大规模重写。

## 执行原则

1. 每一步都保持 CLI 行为兼容。
2. 每次拆分都要有测试覆盖。
3. 优先拆纯逻辑，再拆外部依赖。
4. 机器输出保持 JSON/JSONL 可读，不为了美观破坏脚本组合。
5. 正确性优先于实时性，失败可以接受，错误推进 cursor 不可以。

## 分阶段计划

### Phase 1: Pure Core

抽出不依赖飞书、不依赖 SQLite 的消息同步核心：

- 时间解析。
- 消息规范化。
- record 构造。
- cursor 比较。
- stable horizon。
- bounded pagination 语义。

新增 fake adapter 测试：

- 分页完整读完才返回成功。
- has_more 缺 page_token 必须失败。
- 达到 max pages 仍 has_more 必须失败。
- 乱序消息本地排序后写入候选 record。
- 初始 start 边界不漏。

### Phase 2: Store Boundary

抽出 SQLite store：

- scope 读取。
- run 创建 / 成功 / 失败。
- record 幂等写入。
- cursor 原子提交。
- lock 获取 / 释放。

新增测试：

- 写入 records、run 状态、cursor 在同一事务提交。
- 失败不推进 cursor。
- 重复 record 不重复入库。
- scope lock 不吞掉非 lock 类 SQLite 错误。

### Phase 3: Adapter Boundary

抽出 Lark adapter：

- sent messages fetcher。
- chat messages fetcher。
- chat discovery fetcher。
- contact / member display-name resolver。
- restricted mode classifier。

新增 fake adapter 测试：

- sent search unordered pages。
- received chat ordered pages。
- restricted chat 正确跳过并禁用 scope。
- hot discovery 和 catchup discovery 不互相污染。

### Phase 4: Worker Confidence

围绕 worker 运行语义补测试或 smoke：

- cycle step 顺序。
- hot lane 每轮跑。
- catchup lane 渐进推进。
- doctor 能区分 syncing / catching_up / needs_attention。

## 当前执行切片

Phase 1、Phase 2、Phase 3 adapter 切片和 Phase 4 worker confidence 切片已完成。

长期运行收尾已经完成第一轮：初始 catch-up 已收尾，重启恢复契约、stale lock/run 回收、periodic reconcile、hot discovery 独立 Scope 和 terminal 状态输出已经落地。

v0 质量验收已经完成并固化到 `docs/v0-baseline.md`。

2026-06-17 起，下一轮重心转为通用同步内核抽取：

- `src/core/sync.ts` 承载不依赖飞书、不依赖 SQLite 的同步规则。
- `src/adapters/lark-im/core.mjs` 保留 Lark payload 解释、名称解析辅助和 record 映射。
- `dist/core` 是运行时入口，继续遵守 no runtime TypeScript loader。
- core 级测试覆盖 cursor 比较、窗口过滤、source time precision 和分页完整性。

这一步不改变 LaunchAgent、不改变核心三命令、不改变 SQLite schema，也不引入 UI、语义层或新 Source。

消息过滤、按人/会话/关键词查询等 `messages` 阅读体验增强暂不进入近期计划。当前 `messages` 只承担“查看最近同步事实”的验收入口。

## 执行记录

### 2026-06-13

已完成 Phase 1 的第一步：

- 新增 `scripts/lib/lark-im-core.mjs`，承载不依赖飞书 CLI、不依赖 SQLite 的消息同步核心逻辑。
- `scripts/lark-im-sync.mjs` 改为复用该核心模块，并保持 CLI 行为兼容。
- 新增 fake adapter 风格分页测试：
  - 完整分页读取。
  - `has_more` 缺失 `page_token` 时失败。
  - 达到 max pages 仍有更多数据时失败。
  - 乱序消息经本地排序和 cursor tie-breaker 后得到稳定 record 候选。

随后完成 Phase 2：

- 新增 `scripts/lib/ingestion-store.mjs`，承载通用 SQLite store 边界：
  - scope 读取。
  - run 创建 / 成功 / 失败。
  - record 幂等写入。
  - cursor 原子提交。
  - scope lock 获取 / 释放。
- `scripts/lark-im-sync.mjs` 删除本地 store 函数定义，改为复用 `ingestion-store.mjs`，并保持原有测试导出兼容。
- `acquireLock` 现在只把真实 lock 冲突视为 `false`；结构性 SQLite 错误会继续抛出，避免把数据库损坏或 schema 缺失误判成“锁被占用”。
- 新增 `tests/ingestion-store.test.mjs`：
  - 验证 scope lock 的竞争和 owner release 语义。
  - 验证 lock 获取不会吞掉缺表等结构性错误。
  - 用假的 `test.source` 验证 record run 对 source-agnostic，且正确统计 insert / update / duplicate。
- `npm run check` 已扩展到 `scripts/lib/*.mjs`，新抽象层会进入语法检查。

### 2026-06-14

已完成 Phase 3 的 adapter 切片：

- 新增 `scripts/lib/lark-im-adapter.mjs`，承载 Lark CLI 适配：
  - `lark-cli` 调用、JSON 解析、重试和命令脱敏。
  - sent message fetcher。
  - per-chat received message fetcher。
  - non-muted chat discovery fetcher。
  - contact / chat member display-name resolver。
  - restricted mode classifier。
- `scripts/lark-im-sync.mjs` 不再直接持有 `runLark`、联系人解析、消息拉取、chat-list 拉取等外部系统适配逻辑。
- 修正 people context 的返回结构：名称解析现在返回 `contacts` / `chat_members` / `self`，能被 `recordFromMessage` 直接消费；同时保留旧 alias，方便后续迁移。
- 新增 `tests/lark-im-adapter.test.mjs`：
  - sent search 命令构造和分页 token。
  - non-muted chat-list 输出归一化。
  - contact / chat member 名称注入到 canonical record。
  - restricted mode 分类。
- 用临时 SQLite 库跑过真实 `lark-cli` hot discovery smoke：发现 24 个非免打扰会话，证明 adapter 抽取后的真实路径可用。

已完成 Phase 4 的 worker confidence 切片：

- 新增 `scripts/lib/lark-im-worker-core.mjs`，把 worker 每轮运行语义抽成可测试核心：
  - 固定 step 顺序：sent -> discover-hot -> received-hot -> discover-catchup -> received-catchup。
  - 固定 hot lane 和 catch-up lane 的参数映射。
  - 固定每个 step 和 cycle 的日志事件结构。
  - 统一 compact summary，避免 worker 日志写入完整大对象。
- `scripts/lark-im-worker.mjs` 现在只保留 CLI 参数解析、真实子进程调用、日志写入和循环。
- 新增 `tests/lark-im-worker-core.test.mjs`：
  - 验证 cycle step 顺序。
  - 验证 hot lane 每轮先跑。
  - 验证 catch-up lane 参数。
  - 验证 step failure 会让 cycle 标记为失败，但仍记录完整 cycle event。
  - 验证 compact summary 保留关键运行信号。
- 新增 `scripts/lib/sync-status-core.mjs`，把 `syncing` / `catching_up` / `ok_with_history` / `ok` 的状态规则抽出。
- 新增 `tests/sync-status-core.test.mjs`，覆盖锁、running run、初始 catch-up、历史失败、正常完成等状态解释。
- 用临时 SQLite 库跑过真实 `node scripts/lark-im-worker.mjs --once` smoke：五个 step 全部成功，日志顺序和 summary 正常。

已完成日常可靠性打磨的第一步：

- 新增 `scripts/lib/doctor-core.mjs`，把 doctor 的 live 结果归一化、findings 和 overall 状态计算抽出。
- `doctor --live` 现在能区分：
  - 真实 live probe 故障：仍然是 `needs_attention`。
  - 远端热消息未完全入库：仍然是 `delayed`。
  - 当前 shell 读不到 macOS keychain：显示为 `live unavailable / keychain_unavailable`，不再误报成同步系统故障。
- `scripts/lib/terminal.mjs` 增加显式 `UNAVAILABLE` 状态展示。
- 新增 `tests/doctor-core.test.mjs`，覆盖 keychain 不可用、真实 live 失败、live delayed 对 overall 状态的影响。
- 在 Codex 沙箱内跑过 `node scripts/doctor.mjs --live`：返回 `ok=true`，overall 保持 `syncing`，Live 区域显示 `UNAVAILABLE` 和 keychain 提示。
- 在非沙箱环境跑过真实 `node scripts/doctor.mjs --live --format json`：live probe 成功，状态为 `healthy`。

已完成长期运行收尾的第一轮：

- `scripts/lib/ingestion-store.mjs` 增加 stale sync state recovery：
  - owner pid 已不存在的 lock 会被回收。
  - 对应 running run 会被标记为 `cancelled`。
  - 没有 active lock 的旧 running run 会被标记为 `cancelled`。
  - owner 仍存活但 lock 过期时不强行抢占，只在状态中暴露。
- `sync-status` 在读取状态前会先执行 recovery，因此诊断命令本身可以修复 stale lock/run 的本地状态。
- 新增 `lark.im.unmuted_chat_reconcile` Scope 和 worker step `discover-reconcile`：
  - 默认 24 小时做一次 full reconcile。
  - 未到期时快速跳过。
  - 未完成 snapshot 能从持久化 `page_token` 继续。
  - reconcile 不覆盖 initial full discovery Cursor。
- 新增 `lark.im.unmuted_chat_hot` Scope：
  - hot discovery 每轮运行，但不再污染 `lark.im.unmuted_chat_discovery`。
  - 初始 discovery 的完成状态不再被热会话扫描反复改写。
- `scripts/messages.mjs` 展示增强：
  - 用户发送者优先显示人名。
  - 应用发送者显示为应用。
  - 消息类型显示文本、富文本、卡片、图片等可读标签。
- 真实库当前基线已完成：
  - initial discovery 完成。
  - received scopes 已建立，且无缺 cursor 的 enabled scope。
  - reconcile 完成。
  - doctor OK，数据质量无 missing sender names / missing chat names / invalid bodies。
  - `npm test` 通过。

已完成 v0 质量验收第一轮：

- `node scripts/doctor.mjs --live --format json` 在 Codex 沙箱内会因为 macOS keychain 权限显示 `live unavailable / keychain_unavailable`；这不是后台同步失败。
- 同一命令在非沙箱环境运行成功：
  - live status: `healthy`
  - hot chats found
  - remote messages checked
  - missing_count: 0
  - lag_ms acceptable
  - latest remote message exists locally: true
- `scripts/lark-im-service.mjs status` 增加 Worker 心跳区域：
  - 最近完整 cycle。
  - 最近 step。
  - 当前是否处于 cycle 中。
  - 最近失败。
  - worker JSONL 日志路径。
- `npm test` 当前通过。

已完成 live 一致性验收暴露出的 cursor 精度修复：

- 真实 `doctor --live` 发现远端热消息存在本地缺失。
- 根因不是 worker 停止，也不是 scope 未建立，而是飞书 IM `create_time` 只有分钟精度；旧实现把 cursor 推进到秒级 `window_end`，会跳过后到但仍显示为同一分钟的消息。
- `cursorAfter` 现在按分钟边界推进，并保留 `source_time_precision: "minute"`。
- 同一分钟消息会在下一轮重放，依赖 records 的唯一约束做幂等去重。
- 新增回归测试覆盖“后到同分钟消息仍然 eligible”。

已完成 sender name 质量分类修正：

- `lark-im-enrich-records` 会为无法安全解析的 app sender 写入 `unresolved_app_sender` 标记。
- `lark-im-quality` 区分 actionable sender gaps、system senderless messages 和 unresolved app sender names。
- `doctor` 只因为 actionable sender gaps 报警；系统消息无 sender 和已知无法安全解析的 app sender 保持可见，但不阻塞同步健康。

已完成 app sender 名称降级策略和 v0 baseline 固化：

- 应用发送者名称优先使用官方 Application API。
- 当前应用缺少 `admin:app.info:readonly` 时，会降级到同一会话机器人列表。
- fallback 只允许直接 app_id 匹配，或“一个待解析 app sender + 一个机器人候选”的唯一场景。
- fallback 结果写入 `sender_name_source` 和 `sender_name_confidence`。
- 历史回溯结果：
  - Application API 路径已验证。
  - 权限不足 app_id 不会中断同步。
  - fallback 能解析符合唯一性条件的 app sender。
  - ambiguous fallback 不猜测。
- 新增 `docs/v0-baseline.md`，记录 v0 的保证、非保证、验收命令和下一步观察计划。
- `npm test` 当前通过。

### 2026-06-15

已完成 storage 目录边界迁移：

- `ingestion-store` 实现迁入 `src/storage/sqlite/ingestion-store.mjs`。
- `scripts/lib/ingestion-store.mjs` 保留为兼容 shim。
- `lark-im-sync` 和 `sync-status` 开始直接使用 `src/storage/sqlite` 边界。
- `tests/ingestion-store.test.mjs` 开始直接覆盖 `src` 实现，并验证 shim 仍然 re-export 同一个实现。

已完成 Lark IM adapter 目录边界迁移：

- `lark-im-adapter` 实现迁入 `src/adapters/lark-im/adapter.mjs`。
- `scripts/lib/lark-im-adapter.mjs` 保留为兼容 shim。
- `lark-im-sync` 开始直接使用 `src/adapters/lark-im/adapter.mjs`。
- `tests/lark-im-adapter.test.mjs` 开始直接覆盖 `src` 实现，并验证 shim 仍然 re-export 同一个实现。

已开始 Phase 3 TypeScript 迁移：

- `src/terminal/index.mjs` 迁为 `src/terminal/index.ts`。
- 新增显式 build：`npm run build` 输出 `dist/terminal/index.js` 和类型声明。
- `scripts/lib/terminal.mjs` 改为 re-export 已编译的 `dist/terminal/index.js`，运行时不依赖 TS loader。
- `tests/terminal-rendering.test.mjs` 直接覆盖 `dist` 实现，并继续验证 shim 可用。
- `src/runtime/worker/lark-im-worker-core.mjs` 迁为 `src/runtime/worker/lark-im-worker-core.ts`。
- `scripts/lib/lark-im-worker-core.mjs` 改为 re-export 已编译的 `dist/runtime/worker/lark-im-worker-core.js`。
- `tests/lark-im-worker-core.test.mjs` 直接覆盖 `dist` 实现，并继续验证 shim 可用。
- `src/storage/sqlite/ingestion-store.mjs` 迁为 `src/storage/sqlite/ingestion-store.ts`。
- `scripts/lib/ingestion-store.mjs` 改为 re-export 已编译的 `dist/storage/sqlite/ingestion-store.js`。
- `scripts/lark-im-sync.mjs`、`scripts/sync-status.mjs` 和相关测试改为使用已编译 storage 边界。

已补同步质量测试：

- `tests/lark-im-sync-core.test.mjs` 增加空批次成功同步的 cursor 推进测试，确认不会写入假记录，同时保留同一边界时间的消息重放能力。
- 新增 `tests/lark-im-quality.test.mjs`，使用合成 SQLite 数据验证 `lark-im-quality` 能发现缺 user/app sender name、缺群名、invalid body、deleted/recalled body 和 scope 质量信号。
- `tests/ingestion-store.test.mjs` 增加 scope JSON 解析和失败 run 不污染上一成功 cursor 的测试。
