# CLI v2 migration

本文件记录 Node CLI v2 的入口迁移与行为差异。日常入口为 `npm run help`、`npm run exo -- messages`、`npm run exo -- status`；规范调用是 `node bin/exocortex.mjs`。完整选项由 [registry 命令目录](commands.md) 提供，操作配方见 [Operations](operations.md)，研究与开发入口见 [Development](development.md)。

本地候选不等于真实部署完成。运行数据、账号、已安装服务配置与真实新周期需要单独验收；本文件不记录私人路径、身份或正文。

## 固定数量与门槛

设计取证基线 `9e817b0` 的 `scripts/` 有 **27 个路径**：20 个顶层入口及 7 个 shim。CLI v2 实施基线 `96ba78e` 又包含 `check-generated.mjs` 与 `lib/lark-im-enrichment.mjs`，实际待处理 **29 个路径**。后两项单列迁移，不能把原 27 项的历史口径改成 29。

- **A**：原 26 项在同一完整候选中迁移仓内 imports、spawns、npm/CI、测试、现行文档与已识别本地调用者，再删除旧路径。保留领域反例与输出能力，最终检查由候选验收记录证明。
- **W**：原第 27 项 worker 的真实入口、进程和新周期切换证据已取得；本提交删除 `scripts/lark-im-worker.mjs`。源树退役、提交发布、运行环境切换和全量数据就绪分别取证，不能相互替代，详见下文。
- **X**：只为有实际证据的外部消费者登记限期例外。当前仓内清点没有登记 X，不凭“可能有人使用”保留壳。

本提交为 6 个顶层命令、16 个执行路由，以及 7 个可执行文件：一个公共 bin、四个开发/研究工具、内部 worker 与唯一 Python coverage 工具。原 27 项旧路径在此源树中全部移除，实施基线后增的两项仍单列；普通模块和 dist 不计作可执行入口。源树路径数量不证明运行环境已部署本提交。

## 原 27 项逐条去向

以下旧路径均相对 `scripts/`。表中 A/W 是删除门槛，不是未经执行的通过声明。

| # | 旧路径 | 规范能力或内部去向 | 门槛 |
| --- | --- | --- | --- |
| 1 | `check-syntax.mjs` | `tools/check-syntax.mjs`；npm check 的源码发现与语法能力保留 | A |
| 2 | `doctor.mjs` | `check` 直接聚合 database/sync/quality；live 为显式扩展 | A |
| 3 | `help.mjs` | bin 内置 `--help`；registry 生成根/组/叶子帮助和机器目录 | A |
| 4 | `init-ingestion-core.mjs` | `maintenance init` 与 store 共用 `src/storage/sqlite/initialize.ts`；schema 前锁、权限与 umask 恢复保留 | A |
| 5 | `lark-capability-probe.mjs` | `tools/probes/capabilities.mjs`；metadata/sample/events 明确分开 | A |
| 6 | `lark-im-coverage-check.py` | `tools/coverage/lark-im-coverage-check.py` 唯一算法，由 `check --through` 调用 | A |
| 7 | `lark-im-cursor-probe.mjs` | `tools/probes/cursors.mjs`；native 默认，convenience 显式对照 | A |
| 8 | `lark-im-enrich-records.mjs` | `maintenance enrich --target records`；`src/maintenance/enrich-records.mjs` 保留投影修复和 record CAS | A |
| 9 | `lark-im-enrich-scopes.mjs` | `maintenance enrich --target scopes`；`src/maintenance/enrich-scopes.mjs` 保留独立 config CAS | A |
| 10 | `lark-im-lag-check.mjs` | `check --live`；共享有界采样，显式 cache 写入 | A |
| 11 | `lark-im-quality.mjs` | 默认 `check` 的固定 quality 分项；领域报告可直接测试 | A |
| 12 | `lark-im-replay.mjs` | `maintenance replay`；显式 DB、1–3 scope、固定时窗、严格版本及独立审计保留 | A |
| 13 | `lark-im-service.mjs` | 生命周期到 `service`；观察到 `status`；等待到 `check --wait` | A |
| 14 | `lark-im-sync.mjs` | 公共 `sync` 与 worker 子进程共用 bin；算法与导出直接来自领域模块 | A |
| 15 | `lark-im-worker.mjs` | 内部 `src/runtime/worker/main.mjs`；本提交移除旧桥，部署按 W 门槛验收 | W |
| 16 | `lib/doctor-core.mjs` | 直接 import `src/diagnostics/doctor-core.mjs` 中仍适用的领域规则；聚合归 check | A |
| 17 | `lib/ingestion-store.mjs` | 直接 import `dist/storage/sqlite/ingestion-store.js`，保持 TS/dist 边界 | A |
| 18 | `lib/lark-im-adapter.mjs` | 直接 import `src/adapters/lark-im/adapter.mjs` | A |
| 19 | `lib/lark-im-core.mjs` | 按职责直接 import `src/adapters/lark-im/core.mjs` 等实现 | A |
| 20 | `lib/lark-im-worker-core.mjs` | 直接 import `dist/runtime/worker/lark-im-worker-core.js` | A |
| 21 | `lib/sync-status-core.mjs` | 直接 import `src/diagnostics/sync-status-core.mjs` | A |
| 22 | `lib/terminal.mjs` | 直接 import `dist/terminal/index.js` | A |
| 23 | `maintenance-check.mjs` | 开发 `npm run verify`、显式 `service restart`、只读 `check --wait`；混合配方退役 | A |
| 24 | `messages.mjs` | `messages`；保留数组 JSON、body/canonical/raw/display.card 与文本阅读 | A |
| 25 | `sqlite-maintenance.mjs` | 读取校验到 `check`；backup/prune-runs/compact 到 `maintenance` | A |
| 26 | `sync-repair.mjs` | `maintenance repair` 预览/apply，恢复 fence 与结构计数保留 | A |
| 27 | `sync-status.mjs` | `status --detail` 读进度，`check` 消费同一完整快照报告 | A |

### 实施基线后增的两项

| 旧路径 | 去向 | 删除门槛 |
| --- | --- | --- |
| `scripts/check-generated.mjs` | 普通模块 `src/development/generated-check.mjs`，由 `tools/verify.mjs --generated-only` 驱动；不新增第八个终态入口 | 同批迁移 npm、测试和引用后删除 |
| `scripts/lib/lark-im-enrichment.mjs` | 普通模块 `src/maintenance/enrichment-commit.mjs`，两个 workflow 共用事务 fence | 同批迁移两个调用方后删除 |

## 已识别消费者与闭合要求

| 消费者 | 同批迁移与保留能力 |
| --- | --- |
| npm、CI、syntax/typecheck 发现 | 公共 bin、tools、runtime main 均进入检查；verify 复用一次普通 build，另做独立干净构建对照 |
| 原 doctor/service 报告链 | 直接调用共享报告，消除旧 CLI spawn；快照、失败状态和输出隐私边界保留 |
| worker 子进程 | bin `sync` 与 `maintenance prune-runs --apply`，保留 timeout、取消、JSONL 与退出分类 |
| store 初始化 | 共用显式 initialize 函数，不能靠 import 自执行或重建另一份 schema 前锁 |
| 仓内单元/集成测试 | shim 存在性断言退役；真实分页、卡片、WAL、lease、版本/CAS 等领域反例保留，CLI 接线指向 bin |
| 阅读消费者与共享 card fixture | 原 JSON 数组和私有原始字段保持；阅读无网络、无业务写入，按钮不执行 |
| 运维与现行文档 | 命令按意图迁移；check/restart/wait 分步，预览/apply 默认变化明确 |
| 历史设计与回归记录 | 顶部标明历史时点并链接现行文档；旧路径仅作为历史，不机械改写旧证据 |
| 已安装 LaunchAgent | 已识别安装配置已迁至内部 main，完整参数与其他 plist 字段保留；真实新实例与完整周期证据已取得，后续提交仍须独立审查及运行验收 |

仓内清点覆盖源文件、生成物、配置、测试和文档中的路径引用；授权切换另外核验了已识别 LaunchAgent。该有限范围不能证明所有未知外部调用均不存在。发现具体用户控制的本地调用后应加入同批迁移；真正外部绑定才登记 X。

## 行为差异

| 旧用法/行为 | CLI v2 合同 |
| --- | --- |
| 多个本地诊断入口各自 spawn | `check` 固定聚合三个本地分项，明确各自观察时点；不提供 kind/only 隐形旧命令 |
| service status / sync-status / tail | `status` / `status --detail` / `status --logs --lines N`；日志是显式私有模式 |
| status 非运行即失败 | status 查询成功为 0，可同时展示 STOPPED/PROBLEM；严格通过谓词由 check 提供 |
| 安装即启动、start 强制 kickstart | install 只保存配置；运行中不同配置拒绝覆盖；start 保持已确认运行实例，restart 才更换 |
| install 未完整接受数据库参数 | install 固化解析后的 `--db` 与 WorkerConfig；诊断 `--db` 不修改安装配置 |
| maintenance-check 默认重启 | 开发 verify 与 service restart / check --wait 分开；check 无任何服务变更 |
| enrich 默认写、dry-run 才预览 | enrich 默认预览，只有 `--apply` 提交；records/scopes 必须显式选一，均无 all |
| compact 直接写 | 默认预览，`--apply` 才执行实际回收 |
| lag 的较大默认样本 | `check --live` 默认最多 5 个已发现会话，每会话最多 2 页 × 20 条；`--hot-chats` 收紧会话总数，`--messages-per-chat` 收紧每页条数；`--chat-pages` 仅兼容，不触发远端目录扫描。详见 [Remote sample](operations.md#remote-sample) |
| live 与缓存写入容易混淆 | `check --live` 默认不写；`--write-live-cache` 只在 live 模式可用，TTL 不充当采样时窗 |
| 脚本间默认路径依赖 cwd | 默认 DB/log/backup 按安装 root；显式相对路径按 cwd；内部 worker 使用同一规则 |
| coverage Python 的错误与未完成均为 2 | 公共 check 结构化区分：条件不满足/证据不足为 2，参数/依赖/读取失败为 1 |
| details 欠账与执行失败混用退出 1 | 公共 sync 明确部分完成/欠账为 2，执行失败为 1，worker 同步消费新分类 |
| probe 默认写报告或隐含 events | metadata 不启动 events；sample/events 显式、有界；仅 `--output` 写私有报告 |

`messages` 保留原数组 JSON 与 raw/body/canonical/display 字段。维护预览不放宽数据范围：replay 仍要求显式 DB 和 1–3 个不同 scope，records 默认 limit 1000、scopes 默认 50，sender-only 默认 50/上限 100 且总远端预算 30 秒。`--probe-apps` 只对 records 有效。`--unsafe-details` 仅在 check live 或 records enrichment 模式成立，整份输出按 private 处理。

已退役桥曾保留重复参数最后取值及 cwd 默认路径规则；这些专用兼容分支已在本提交删除。内部入口、公共命令和持久服务配置继续拒绝重复参数，显式可重复的选项仍按其声明处理。内部 worker 的 `--once` 与 `--max-cycles` 各出现一次时，仍按最后出现的生命周期选项决定；两者均不进入长期服务配置。

## 审查范围必须注明基线

历史候选 `3689b35` 的 CLI 增量是 `96ba78e..3689b35`：2 个提交、129 个唯一新侧 blob，其中 1 个版本不在最终树。`9e817b0..96ba78e` 是此前继承的 16 个提交、190 个 blob；从 `9e817b0` 累计到 `3689b35` 才是 18 个提交、319 个 blob。累计范围中不在最终树的版本还包括后续删除或移动的继承文件，不能全部称为本次 CLI 的中间版本。

blob 口径为区间内每个提交新增或修改文件的新侧 Git 对象去重，保留中间版本；不是最终文件数。报告、补丁和 bundle 都应明确基线、终点与必要前置提交。后续修复另列新提交范围及其审查结果，不能用继承历史的数量代替本次增量，也不能把旧候选的审查结论自动延伸到新 SHA。可先用 `git rev-list --count 96ba78e..3689b35` 和 `git rev-list --count 9e817b0..3689b35` 核对两个历史提交区间，再逐提交核对 tree/blob 清单。

## Worker 切换门槛 W

以下记录 **2026-10-04 部署 `a0e6bbf` 时的固定取证**，不证明任何后续提交已发布或部署。该次授权切换中：旧实例及写者退出，一致备份与启动前 raw/body/canonical/hash/version/游标严格等价审计通过，完整显式 worker 参数及其他 plist 字段保留，已识别 LaunchAgent 指向内部 main。新实例的 OS、活动事件和数据库身份一致，并已完成调用后开始的完整成功周期。

该周期证据不等于全局检查通过：验收时 `check --wait` 仍退出 2（`final_local_not_ready`），仍有普通发送者姓名经有界预览未解析、未形成更新，未执行写入；固定部署目标的覆盖仍有尾部未到，未发现起点缺口或内部空洞。这些是该次验收时点的未完成项；后台自然推进不构成后续通过证明。`a0e6bbf` 仍含旧桥，本提交将其移除。提交的独立审查、发布及运行环境切换结果应由对应版本的发布记录证明。

后续切换仍须遵循以下门槛：

1. 保存原代码、完整安装配置和独立一致性备份；确认目标数据库与全部 WorkerConfig。
2. 停止旧 worker 并确认旧实例及子进程退出；launchd 停止不证明独立前台同步结束。结合进程身份与写入 fence 确认没有活跃写者，不能仅凭 lease 推断存活或死亡。无法停止或身份未知就停止切换，不强杀未知任务。
3. 安装新配置，核验所有已识别 plist 指向 `src/runtime/worker/main.mjs`，参数完整且路径正确。
4. 启动新实例，使用 `check --wait` 验证调用后新完整周期，再分别做本地、固定目标覆盖和可选远端验收。
5. 确认已识别调用均迁移后，在隔离候选删除最后的桥并完成独立审查与发布。若分发布，最多跨一个迁移发布；仅隔离删除、运行环境仍有桥时不能宣称入口退役已发布完成。

失败时恢复代码与配置，不用旧备份覆盖回灌当前数据库。源文件路径数量达标不能代替新周期、覆盖或隐私验收。

## 外部例外 X

当前登记为空。未来每项必须包含具体消费者及 owner、实际命令或配置证据、受影响路径、迁移工作项和截止日期。期限为下一发布或登记后 14 天，以先到者为准；只保留该路径所需桥，不自动续期。到期未迁移是明确阻塞，不能宣布零旧路径目标完成。
