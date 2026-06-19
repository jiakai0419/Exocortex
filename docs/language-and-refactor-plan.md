# Language and Refactor Plan

## 结论

衍我的主系统语言方向定为：

```text
TypeScript on Node.js
```

但迁移方式必须是渐进式的：

```text
先类型检查 JavaScript
再稳定模块边界
再迁移纯核心模块
最后迁移 runtime 入口
```

当前不做 Go / Rust / Python 主系统重写，也不做一次性 TypeScript rewrite。

## 背景

截至 2026-06-15，项目已经不再是一次性 spike：

- 后台 Lark IM worker 已经通过 macOS LaunchAgent 长期运行。
- 本地 SQLite schema 已经沉淀出 Source / Scope / Cursor / Record / Run / Lock。
- `src/` 已经承载 core、SQLite store、Lark IM adapter、worker core、terminal helper 和 CLI command 边界。
- `scripts/` 继续保留稳定用户入口和兼容 wrapper。
- CI 已经运行 `npm run check`、`npm run typecheck`、`npm run build:check` 和 `npm test`。
- Terminal-first 已经成为长期交互原则。
- public-safe 已经成为仓库原则。

运行数据和本地数据库只作为判断系统形态的输入，不进入本文档。本文档不记录真实消息、真实会话、真实人员、真实链接或具体本机运行规模。

## 为什么要现在规划

现在代码还足够小，重构成本可控；早期复杂度已经被逐步拆出边界：

- `scripts/lark-im-sync.mjs` 已收敛为稳定入口和兼容 re-export。
- `src/cli/lark-im-sync-command.mjs` 已承载 `lark-im-sync` CLI 编排。
- `src/adapters/lark-im/sync-runner.mjs` 已承载 sent / discovery / received 同步执行。
- 用户入口仍在 `scripts/` 下，但 production CLI implementation 已开始迁入 `src/cli`。
- 诊断入口、研究 probe、维护脚本仍有继续迁移和分层空间。
- 一些核心契约仍只靠约定或局部类型表达，例如部分 adapter result shape、diagnostics result shape、CLI summary shape。
- 未来接入 docs、calendar、mail、browser、filesystem、semantic layer 后，弱类型边界会快速变成维护成本。

因此现在应该开始规划语言和模块边界，避免未来在第二个 Source 或语义层出现后再被迫大拆。

## 语言选择

### TypeScript

TypeScript 是主系统的目标语言。

原因：

- 保留当前 Node.js、ESM、`lark-cli`、SQLite CLI、terminal-first 的运行方式。
- 能把 Source / Scope / Cursor / Record / Run / Adapter 等长期抽象变成可检查契约。
- 能渐进迁移，不需要一次性重写。
- 与 GitHub Actions、Node test runner、当前脚本模型兼容。
- 对 public repo 友好：类型定义能帮助外部读者理解系统边界。

TypeScript 在本项目里的定位是：

```text
correctness boundary, not architecture spectacle
```

也就是说，它是为了降低长期同步错误、接口漂移和数据模型误用，不是为了引入复杂构建体系。

### JavaScript

JavaScript 不是要立刻废弃。

短期内继续保留：

- `scripts/*.mjs` 作为稳定 CLI 入口。
- 当前 LaunchAgent 调用路径。
- 现有测试和日常命令。

JavaScript 的下一步不是直接删除，而是先加类型检查：

```text
// @ts-check
JSDoc typedef
tsc --noEmit
```

### Python

Python 可以作为未来语义实验和数据分析的旁路工具，但不作为同步主系统语言。

适合 Python 的范围：

- embedding 实验。
- 语义摘要。
- notebook-style 数据分析。
- 一次性导入/导出工具。

不适合作为当前主 worker 的原因：

- 当前主链路已经围绕 Node.js 和 `lark-cli` 建立。
- Python 重写不能提升当前最关键的 cursor / recovery 正确性。
- 双主语言会提高部署、CI、LaunchAgent 和日常操作复杂度。

### Go

Go 暂不作为主系统语言。

Go 的优势是单 binary、daemon、并发和部署稳定；但当前阶段不值得切换：

- 需要重写大量已经验证的 Node.js 逻辑。
- 与现有 `lark-cli` JSON wrapper 的收益差异不大。
- 会打断当前 terminal-first 和测试体系。

只有当未来需要跨平台长期后台服务、并且 Node.js runtime 本身成为主要运维问题时，才重新评估。

### Rust

Rust 暂不作为主系统语言。

Rust 适合强可靠系统，但当前产品仍在快速探索。它会显著提高修改成本，不符合衍我现在“先把抽象想清楚、边做边校正”的阶段。

## 不做什么

当前明确不做：

- 不做 big-bang rewrite。
- 不为了迁移语言暂停后台同步。
- 不让 LaunchAgent 依赖 runtime transpiler，例如 `tsx`、`ts-node`。
- 不在生产路径里引入 bundler。
- 不把 probe / maintenance / production worker 混在一次迁移里。
- 不用语言迁移掩盖同步正确性问题。

## 目标模块边界

目标结构应逐步走向：

```text
src/core
src/storage/sqlite
src/adapters/lark-im
src/runtime/worker
src/terminal
src/cli
scripts
tests
docs
```

### `src/core`

纯领域逻辑，不依赖 Lark、不依赖 SQLite、不依赖进程环境。

包含：

- Source / Scope / Cursor / Record / Run 类型。
- 时间窗口和 stable horizon。
- cursor compare / tie-breaker。
- record normalize。
- pagination 完整性规则。

### `src/storage/sqlite`

本地持久化边界。

当前状态：

- 源码在 `src/storage/sqlite/ingestion-store.ts`。
- 构建产物在 `dist/storage/sqlite/ingestion-store.js`。
- 运行时兼容入口仍是 `scripts/lib/ingestion-store.mjs`，它只 re-export 已编译 JS。

包含：

- schema/migration 调用。
- scope read/write。
- run create/succeed/fail/cancel。
- record upsert。
- lock/recovery。

它不应该知道 Lark API 的业务细节。

### `src/adapters/lark-im`

飞书 IM 适配层。

包含：

- `transport.mjs`：`lark-cli` 调用、JSON 解析、retry、命令脱敏、transient failure 分类。
- `adapter.mjs`：Lark IM API shape normalization 和业务组合。
- `message-record.mjs`：Lark message payload 解释、名称解析辅助和 record 映射。
- `core.mjs`：兼容门面和 Lark IM 同步规则组合层。
- `sync-runner.mjs`：Lark IM sent / discovery / received 同步执行层，负责把 adapter、core 和 store 组合成一次可 checkpoint 的同步 run；通过 `createSyncRunner(deps)` 支持生产真实依赖和测试 fake deps 分离。
- sent messages fetch。
- per-chat received messages fetch。
- chat discovery。
- contact/member/app display-name enrichment。
- restricted mode 分类。

它可以知道 Lark payload，但不直接写 SQLite。

### `src/runtime/worker`

长期运行编排层。

当前状态：

- 纯 worker core 源码在 `src/runtime/worker/lark-im-worker-core.ts`。
- 构建产物在 `dist/runtime/worker/lark-im-worker-core.js`。
- 运行时兼容入口仍是 `scripts/lib/lark-im-worker-core.mjs`，它只 re-export 已编译 JS。

包含：

- worker cycle step 顺序。
- hot lane / catch-up lane / reconcile lane。
- JSONL heartbeat。
- failure isolation。

### `src/terminal`

Terminal 输出渲染层。

当前状态：

- 源码在 `src/terminal/index.ts`。
- 构建产物在 `dist/terminal/index.js`。
- 运行时兼容入口仍是 `scripts/lib/terminal.mjs`，它只 re-export 已编译 JS。

原则继续沿用 `docs/terminal-experience.md`：

- text 给人看。
- `--format json` 给机器读。
- 颜色只辅助扫描，不承载唯一语义。

### `src/cli`

CLI command implementation。

当前状态：

- `src/cli/lark-im-sync-command.mjs` 已承载 `lark-im-sync` 的参数解析、help 文本、同步执行 summary 和 CLI stdout/stderr/exit-code 处理。
- `scripts/lark-im-sync.mjs` 保留为稳定入口和兼容 re-export，不再承载同步 CLI 编排。

`scripts/*.mjs` 最终应变成很薄的入口：

```text
parse argv -> call src/cli command -> render result
```

### `scripts`

`scripts` 是稳定用户入口，不是主要业务代码所在层。

日常命令路径不能轻易变化：

```text
npm run help
node scripts/messages.mjs --limit 20
node scripts/lark-im-service.mjs status
```

LaunchAgent 依赖的入口也必须保持稳定，除非有明确迁移步骤和回滚方案。

## 迁移阶段

### Phase 0: 记录决策

状态：当前文档。

目标：

- 明确 TypeScript 是主方向。
- 明确不做一次性重写。
- 明确 runtime 稳定性优先于语言洁癖。

验收：

- 文档进入 README。
- 不改运行行为。

### Phase 1: Type-check JavaScript

状态：前七刀已落地。

目标：

- 引入 `tsconfig.json`，启用 `allowJs` / `checkJs` / `noEmit`。
- 增加 `npm run typecheck`。
- CI 增加 typecheck。
- 优先给 core/store/adapter 增加 JSDoc typedef。

约束：

- 不移动文件。
- 不改变 LaunchAgent。
- 不改变 CLI 命令。
- 不引入运行时 TypeScript loader。

第一批类型应覆盖：

- `SourceId`
- `ScopeId`
- `Cursor`
- `Record`
- `SyncRun`
- `SyncScope`
- `MessageWindow`
- `LarkMessage`
- `LarkImAdapter`
- `Store`
- `WorkerCycle`
- `DiagnosticReport`

当前第一批已经覆盖：

- `scripts/help.mjs`
- `scripts/doctor.mjs`
- `scripts/sync-status.mjs`
- `scripts/messages.mjs`
- `scripts/lark-im-service.mjs`
- `scripts/lark-im-worker.mjs`
- `scripts/lark-im-sync.mjs`
- `src/cli/lark-im-sync-command.mjs`
- `scripts/lib/lark-im-core.mjs`
- `src/storage/sqlite/ingestion-store.mjs`
- `scripts/lib/ingestion-store.mjs`
- `src/adapters/lark-im/adapter.mjs`
- `src/adapters/lark-im/sync-runner.mjs`
- `scripts/lib/lark-im-adapter.mjs`
- `scripts/lib/lark-im-worker-core.mjs`
- `scripts/lib/sync-status-core.mjs`
- `scripts/lib/doctor-core.mjs`
- `scripts/lib/terminal.mjs`

验收：

```bash
npm run typecheck
npm run check
npm test
node scripts/lark-im-service.mjs status
```

### Phase 2: 稳定目录边界

状态：Phase 2 已收口，目录边界已落地：

- `terminal` 已迁入 `src/terminal/index.mjs`，`scripts/lib/terminal.mjs` 保留为兼容 shim。
- `doctor-core` / `sync-status-core` 已迁入 `src/diagnostics`，`scripts/lib` 下保留兼容 shim。
- `lark-im-core` 已迁入 `src/adapters/lark-im/core.mjs`，`scripts/lib/lark-im-core.mjs` 保留为兼容 shim。
- `ingestion-store` 已迁入 `src/storage/sqlite/ingestion-store.mjs`，`scripts/lib/ingestion-store.mjs` 保留为兼容 shim。
- `lark-im-adapter` 已迁入 `src/adapters/lark-im/adapter.mjs`，`scripts/lib/lark-im-adapter.mjs` 保留为兼容 shim。
- `lark-im-name-resolver` 已拆入 `src/adapters/lark-im/name-resolver.mjs`，让 sender/contact/member/app 名称解析与消息 fetch facade 分离。
- `lark-im-sync-runner` 已拆入 `src/adapters/lark-im/sync-runner.mjs`，并增加 `createSyncRunner(deps)` 依赖注入边界，让 `scripts/lark-im-sync.mjs` 回到 CLI 入口和调度层。
- `lark-im-sync-command` 已拆入 `src/cli/lark-im-sync-command.mjs`，让 `scripts/lark-im-sync.mjs` 回到稳定入口和兼容 re-export。
- `lark-im-worker-core` 已迁入 `src/runtime/worker/lark-im-worker-core.mjs`，`scripts/lib/lark-im-worker-core.mjs` 保留为兼容 shim。

目标：

- 把可复用库代码逐步从 `scripts/lib` 移向 `src`。
- 保留兼容 shim，避免一次性改动所有 import。
- 把 production、diagnostics、maintenance、research probe 的边界写清楚。

推荐顺序：

1. `terminal`：已完成
2. `doctor-core` / `sync-status-core`：已完成
3. `lark-im-core`：已完成
4. `ingestion-store`：已完成
5. `lark-im-adapter`：已完成
6. `lark-im-worker-core`：已完成
7. `lark-im-sync-runner`：已完成
8. `lark-im-sync-command`：已完成

约束：

- 每次只移动一个边界。
- 每次移动后跑完整测试。
- `scripts/*.mjs` 继续可直接执行。
- `npm run help -- --all` 仍能列出所有脚本。

验收：

```bash
npm run typecheck
npm run check
npm test
node scripts/lark-im-service.mjs status
```

### Phase 3: 迁移纯核心到 TypeScript

状态：已开始。`src/core`、`src/terminal`、`src/runtime/worker` 的纯 core 和 `src/storage/sqlite` 已完成第一版 TS 迁移，用于验证显式 build、`dist` 运行时入口和兼容 shim 的组合是否稳定。

目标：

- 先迁移不依赖外部系统的纯核心模块。
- 引入 `src/**/*.ts -> dist/**/*.js` 的显式 build。
- 不让后台服务依赖未编译 TypeScript。

优先迁移：

1. `src/core`：已完成第一版 TS 迁移，当前承载 cursor 比较、时间窗口、source time precision 和分页完整性规则
2. `src/terminal`：已完成第一版 TS 迁移
3. `src/runtime/worker` 的纯函数部分：已完成第一版 TS 迁移
4. `src/storage/sqlite` 的类型和 SQL 构造边界：已完成第一版 TS 迁移

暂缓迁移：

- `lark-cli` adapter。
- LaunchAgent service command。
- live probe / capability probe。
- 一次性 maintenance 脚本。

约束：

- `dist` 不作为产品数据，不应混入本地运行状态。
- build 必须可重复。
- `scripts/*.mjs` 必须只 import 已编译 JS，不能 import TS source。
- 若某个 `scripts/lib` shim 指向 `dist`，对应测试也必须直接覆盖 `dist` 实现，并验证 shim 仍然可用。
- CI 必须运行 `npm run build:check`，保证提交里的 `dist` 与 TS 源码一致。

验收：

```bash
npm run build
npm run build:check
npm run typecheck
npm run check
npm test
node scripts/lark-im-service.mjs status
```

### Phase 4: 迁移 production CLI

状态：已开始。`lark-im-sync` 已先行迁入 `src/cli/lark-im-sync-command.mjs`，因为它的同步执行层已经通过 `sync-runner` 独立出来并补齐成功/失败路径测试。

目标：

- 把 `lark-im-sync`、`lark-im-worker`、`sync-status`、`doctor` 的实现迁移到 typed CLI layer。
- `scripts/*.mjs` 继续作为薄 wrapper。

原建议迁移顺序：

1. `sync-status`
2. `doctor`
3. `lark-im-worker`
4. `lark-im-sync`：已完成第一版 JS CLI command 抽取

原因：

- `sync-status` / `doctor` 风险较低，能先验证 typed CLI pattern。
- `lark-im-worker` 涉及长期运行，但业务逻辑较少。
- `lark-im-sync` 是核心同步入口，应最后迁移。

实际执行中，`lark-im-sync` 先完成 JS CLI command 抽取，是因为它的 sync runner、adapter 和 store 边界已经先被拆出，并补齐了成功/失败路径测试。后续不应据此默认继续高风险入口迁移；每一步仍以运行稳定性优先。

验收：

- 核心三命令不变。
- LaunchAgent 重启后正常。
- 观察至少一个 worker cycle 成功。
- 本地 health 不退化。

### Phase 5: 再评估新 Source 和语义层

只有在 Phase 1-4 的主体完成后，再开始第二个 Source 或语义层。

原因：

- 第二个 Source 会检验 Source Adapter 抽象。
- 语义层会引入更多数据类型和隐私边界。
- 如果此时仍没有类型契约，复杂度会显著上升。

## 何时可以停

迁移不是为了“全仓库必须 TypeScript”。

可以长期停在以下状态：

```text
核心 typed
runtime wrapper stable
probe/maintenance scripts mostly JavaScript
```

如果某些脚本低频、一次性、风险可控，保留 JavaScript 是可以接受的。

## 何时必须暂停迁移

出现以下情况时，暂停语言迁移，先修同步可靠性：

- worker 无法稳定运行。
- `received_without_cursor` 重新长期大于 0。
- `doctor` 或 `lark-im-quality` 出现当前故障。
- cursor 推进或 record 幂等写入出现回归。
- CI 不稳定。
- LaunchAgent 重启后无法恢复。

同步正确性永远优先于语言迁移。

## Public-safe 要求

语言迁移过程中继续遵守 `docs/product.md` 的 Public Repository 原则。

特别要求：

- 类型和诊断 fixture 使用 anonymized shape fixtures：字段形状可以来自真实 API，但值必须是脱敏占位符。
- 不把真实 SQLite 数据导出为测试 fixture。
- 不把真实 probe JSON 放入仓库。
- 不在文档里记录真实消息、真实群名、真实人名、真实链接或本机运行规模。
- 错误类型、日志类型、diagnostic 类型应默认支持 redaction。

## 决策检查表

每次迁移前确认：

- 这一步是否保持核心三命令不变？
- 这一步是否不改变 LaunchAgent 入口？
- 这一步是否有测试覆盖？
- 这一步是否能独立回滚？
- 这一步是否没有把真实运行数据写进仓库？
- 这一步是否降低长期复杂度，而不是只改变文件后缀？

## 下一步

下一次实际改代码前，建议先做一个小复盘：

1. Phase 3 已经用 `src/core`、`src/terminal`、`src/runtime/worker` 和 `src/storage/sqlite` 验证了 `src/**/*.ts -> dist/**/*.js` 的显式 build。
2. 同步质量测试已经覆盖 cursor 边界推进、边界重放安全、source time precision、分页完整性、质量报告诊断、scope JSON 解析和失败 run 不污染成功 cursor。
3. `src/adapters/lark-im/sync-runner.mjs` 已从 `scripts/lark-im-sync.mjs` 拆出，并有 fake deps 测试覆盖 sent 成功/失败、scope locked/disabled、received unsupported、received batch limit 和 discovery 注入/分页异常路径。
4. `src/cli/lark-im-sync-command.mjs` 已承载 `lark-im-sync` CLI 行为；下一步先观察 worker 和 CI，再考虑是否继续迁 `sync-status` 或 `doctor`，不要急着做 TypeScript production CLI rewrite。
5. 继续保持 no runtime loader、不改 LaunchAgent、不改核心三命令。
