# Command catalog

<!-- Generated from src/cli/registry.mjs through the public machine catalog. Update from registry; do not hand-edit option rows. -->

公共规范入口：`node bin/exocortex.mjs`；人类快捷入口：`npm run exo --`。本表从 `--help --all --format json` 的 registry 目录生成，共 **6 个顶层命令、16 个执行路由**。默认帮助突出 messages、status 与帮助；开发和研究工具见 [Development](development.md)。

默认路径相对安装 root，显式相对路径按 cwd 解析。`messages` 与显式日志/unsafe 模式为私有输出；默认诊断只输出安全投影。`sync` 保留已有 JSON summary 契约，仅支持 JSON。域内参数关系仍由各命令校验，不因目录列出而自动允许任意组合。操作配方见 [Operations](operations.md)，行为变化与退役门槛见 [CLI migration](cli-migration.md)。

## Routes

<!-- BEGIN GENERATED routes -->
| 命令 | 能力 | 默认效果 | 默认输出级别 |
| --- | --- | --- | --- |
| `messages` | Read local messages newest message time first, including original private JSON. Cards are captured API snapshots and may differ from the current client state. JSON retains card rendering status and diagnostics. | local-read | `private` |
| `status` | Observe service, health, activity and freshness without live requests. | local-read | `public-safe` |
| `check` | Collect database, sync and quality evidence and requested extensions. | local-read | `public-safe` |
| `sync` | Run one bounded pass, preserving message and detail-debt contracts. | remote-read, database-write, activity-write | `public-safe` |
| `service install` | Install configuration without starting the worker. | configuration-write | `public-safe` |
| `service start` | Ensure the configured service is running. | service-lifecycle | `public-safe` |
| `service stop` | Stop the configured service. | service-lifecycle | `public-safe` |
| `service restart` | Explicitly replace the running service instance. | service-lifecycle | `public-safe` |
| `service uninstall` | Stop and remove the installed service configuration. | service-lifecycle | `public-safe` |
| `maintenance init` | Initialize schema with its independent initialization lock. | database-write, permissions-write | `public-safe` |
| `maintenance backup` | Create and verify a private backup before publishing it. | backup-write, same-source-backup-cleanup | `public-safe` |
| `maintenance enrich` | Preview enrichment of one target; apply commits through its own CAS. | local-read, remote-read | `public-safe` |
| `maintenance repair` | Preview structural recovery; apply uses existing fences. | local-read | `public-safe` |
| `maintenance replay` | Preview replay of explicit scopes and a fixed interval. | local-read, remote-read | `public-safe` |
| `maintenance prune-runs` | Preview run-history retention; applying can remove coverage evidence. | local-read | `public-safe` |
| `maintenance compact` | Preview database compaction; --apply permits the write. | local-read | `public-safe` |
<!-- END GENERATED routes -->

## Help and machine discovery

```sh
npm run help
node bin/exocortex.mjs --help --all
node bin/exocortex.mjs service --help
node bin/exocortex.mjs maintenance enrich --help
node bin/exocortex.mjs --help --all --format json
```

`--help` / `-h` 不执行业务命令；根帮助的 `--all` 只展开目录，不开启全部检查。组或叶子帮助可用 `--format json` 机器发现。JSON 消费者直接调用 Node，避免 npm 前缀。没有 help/diagnose/probe/worker 公共同义路由。

## Options and explicit modes

<!-- BEGIN GENERATED options -->
### messages

Read local messages newest message time first, including original private JSON. Cards are captured API snapshots and may differ from the current client state. JSON retains card rendering status and diagnostics.

默认效果：`local-read`；输出：`private`。

| 参数 | 类型/取值 | 默认 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `--db` | path | `data/exocortex.sqlite` | — | Database; default relative to installation root, explicit relative paths to cwd. |
| `--format` | text/json | `text` | — | Output format. |
| `--direction` | all/sent/received | `all` | — | Message direction. |
| `--limit` | integer | `30` | ≥ 1 | Maximum messages. |
| `--search` | string | `空字符串` | — | Search stored body with SQLite LIKE: % matches any sequence; _ matches one character. Input is wrapped in %; backslash is literal. |

### status

Observe service, health, activity and freshness without live requests.

默认效果：`local-read`；输出：`public-safe`。

| 显式模式 | 附加效果或输出级别 |
| --- | --- |
| `--logs` | private |

| 参数 | 类型/取值 | 默认 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `--db` | path | `data/exocortex.sqlite` | — | Database; default relative to installation root, explicit relative paths to cwd. |
| `--format` | text/json | `text` | — | Output format. |
| `--log-dir` | path | `logs/lark-im` | — | Worker log directory. |
| `--detail` | boolean | `false` | — | Include safe sync progress details. |
| `--logs` | boolean | `false` | — | Include a private bounded tail of existing logs. |
| `--lines` | integer | `20` | ≥ 1 | Log tail length; requires --logs. |

### check

Collect database, sync and quality evidence and requested extensions.

默认效果：`local-read`；输出：`public-safe`。

| 显式模式 | 附加效果或输出级别 |
| --- | --- |
| `--live` | remote-read |
| `--live --write-live-cache` | cache-write |
| `--live --unsafe-details` | private |

| 参数 | 类型/取值 | 默认 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `--db` | path | `data/exocortex.sqlite` | — | Database; default relative to installation root, explicit relative paths to cwd. |
| `--format` | text/json | `text` | — | Output format. |
| `--log-dir` | path | `logs/lark-im` | — | Worker log directory. |
| `--backup-dir` | path | `backups/private` | — | Private backup directory. |
| `--live` | boolean | `false` | — | Read a bounded remote sample. |
| `--write-live-cache` | boolean | `false` | — | Write the safe sample cache; requires --live. |
| `--unsafe-details` | boolean | `false` | — | Include private sample details; requires --live. |
| `--chat-pages` | integer | `5` | ≥ 1 | Legacy compatibility bound; live sampling uses local discovered chats. |
| `--hot-chats` | integer | `5` | ≥ 1 | Maximum sampled chats, capped at five; requires --live. |
| `--messages-per-chat` | integer | `20` | ≥ 1；≤ 50 | Messages per page, capped at twenty and two pages per chat; requires --live. |
| `--start` | string | — | — | Sample start with timezone; requires --live. |
| `--end` | string | — | — | Sample end with timezone; requires --live. |
| `--through` | string | — | — | Verify coverage to this fixed timezone timestamp. |
| `--backup` | path | — | — | Independently verify this existing backup. |
| `--latest-backup` | boolean | `false` | — | Verify the latest matching v2 backup. |
| `--wait` | boolean | `false` | — | Wait for a new complete worker cycle; no service changes. |
| `--timeout-seconds` | integer | `180` | ≥ 1 | Wait deadline; requires --wait. |
| `--poll-seconds` | integer | `5` | ≥ 1 | Local polling interval; requires --wait. |

### sync

Run one bounded pass, preserving message and detail-debt contracts.

默认效果：`remote-read, database-write, activity-write`；输出：`public-safe`。

| 参数 | 类型/取值 | 默认 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `--db` | path | `data/exocortex.sqlite` | — | Db. |
| `--scope` | all/sent/discover/received/details | `all` | — | Scope. |
| `--start` | string | — | — | Confirm persistent baseline: ISO timestamp with explicit timezone; defaults to local midnight for a new source. |
| `--end` | string | — | — | Run upper bound; defaults to now. |
| `--page-size` | integer | `50` | — | Message page size, capped at 50. |
| `--max-pages` | integer | `40` | — | Max pages. |
| `--chat-page-size` | integer | `100` | — | Discovery page size, capped at 100. |
| `--max-chat-pages` | integer | `100` | — | Max chat pages. |
| `--discovery-pages-per-run` | integer | `1` | — | Discovery pages per run. |
| `--received-scopes-per-run` | integer | `0` | ≥ 0 | Received scopes per run; zero means all. |
| `--discovery-mode` | cursor/hot/reconcile | `cursor` | — | Discovery mode. |
| `--reconcile-interval-hours` | integer | `24` | — | Reconcile interval hours. |
| `--received-mode` | all/hot/catchup | `all` | — | Received mode. |
| `--chat-types` | string | `group,p2p` | — | Chat types. |
| `--stable-horizon-seconds` | integer | `30` | ≥ 0 | Stable horizon seconds. |
| `--lock-ttl-seconds` | integer | `600` | — | Lock ttl seconds. |
| `--retries` | integer | `4` | — | Retries. |
| `--retry-delay-ms` | integer | `2000` | — | Retry delay ms. |
| `--detail-limit` | integer | `5` | — | Due detail roots per details run, capped at 20. |
| `--detail-scope` | string | — | — | Detail scope. |
| `--format` | json | `json` | — | Existing single-pass JSON summary contract. |

### service install

Install configuration without starting the worker.

默认效果：`configuration-write`；输出：`public-safe`。

| 参数 | 类型/取值 | 默认 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `--db` | path | `data/exocortex.sqlite` | — | SQLite database path. |
| `--interval-seconds` | integer | `60` | — | Sleep between cycles. |
| `--received-scopes-per-cycle` | integer | `50` | — | Catch-up received scopes per cycle. |
| `--hot-received-scopes-per-cycle` | integer | `20` | — | Recently active received scopes per cycle. |
| `--discovery-pages-per-cycle` | integer | `1` | — | Full discovery pages per cycle. |
| `--hot-discovery-pages-per-cycle` | integer | `5` | — | Recently active discovery pages per cycle. |
| `--max-chat-pages` | integer | `300` | — | Maximum full-discovery pages per snapshot. |
| `--reconcile-interval-hours` | integer | `24` | — | Minimum hours between full reconcile snapshots. |
| `--chat-types` | string | `group,p2p` | — | Chat types for discovery. |
| `--log-dir` | path | `logs/lark-im` | — | Worker JSONL log directory. |
| `--step-timeout-seconds` | integer | `600` | — | Hard timeout for each child step. |
| `--log-max-bytes` | integer | `10485760` | — | Rotate worker.jsonl at this size. |
| `--log-keep-files` | integer | `5` | — | Rotated worker logs to keep. |
| `--retention-every-cycles` | integer | `1440` | — | Apply run retention every N cycles. |
| `--adaptive-fair` | boolean | `false` | — | Adapt the fair scope batch; not an HTTP rate limiter. |
| `--adaptive-fair-min` | integer | `10` | — | Minimum adaptive fair batch. |
| `--adaptive-fair-max` | integer | `50` | — | Maximum adaptive fair batch. |
| `--adaptive-target-cycle-seconds` | integer | `90` | — | Target work plus interval duration. |
| `--remote-sample-interval-seconds` | integer | `900` | ≥ 0；≤ 1800 | Bounded remote sample interval (900–1800 seconds; 0 disables). |
| `--format` | text/json | `text` | — | Output format. |

### service start

Ensure the configured service is running.

默认效果：`service-lifecycle`；输出：`public-safe`。

| 参数 | 类型/取值 | 默认 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `--format` | text/json | `text` | — | Output format. |

### service stop

Stop the configured service.

默认效果：`service-lifecycle`；输出：`public-safe`。

| 参数 | 类型/取值 | 默认 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `--format` | text/json | `text` | — | Output format. |

### service restart

Explicitly replace the running service instance.

默认效果：`service-lifecycle`；输出：`public-safe`。

| 参数 | 类型/取值 | 默认 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `--format` | text/json | `text` | — | Output format. |

### service uninstall

Stop and remove the installed service configuration.

默认效果：`service-lifecycle`；输出：`public-safe`。

| 参数 | 类型/取值 | 默认 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `--format` | text/json | `text` | — | Output format. |

### maintenance init

Initialize schema with its independent initialization lock.

默认效果：`database-write, permissions-write`；输出：`public-safe`。

| 参数 | 类型/取值 | 默认 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `--db` | path | `data/exocortex.sqlite` | — | Database; default relative to installation root, explicit relative paths to cwd. |
| `--format` | text/json | `text` | — | Output format. |

### maintenance backup

Create and verify a private backup before publishing it.

默认效果：`backup-write, same-source-backup-cleanup`；输出：`public-safe`。

| 参数 | 类型/取值 | 默认 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `--db` | path | `data/exocortex.sqlite` | — | Database; default relative to installation root, explicit relative paths to cwd. |
| `--format` | text/json | `text` | — | Output format. |
| `--backup-dir` | path | `backups/private` | — | Private backup directory. |
| `--backup-keep-count` | integer | `7` | ≥ 1 | Same-source backup count to retain. |
| `--backup-keep-days` | integer | `30` | ≥ 1 | Same-source backup retention days. |

### maintenance enrich

Preview enrichment of one target; apply commits through its own CAS.

默认效果：`local-read, remote-read`；输出：`public-safe`。

| 显式模式 | 附加效果或输出级别 |
| --- | --- |
| `--apply` | database-write |
| `--unsafe-details` | private |

| 参数 | 类型/取值 | 默认 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `--db` | path | `data/exocortex.sqlite` | — | Database; default relative to installation root, explicit relative paths to cwd. |
| `--format` | text/json | `text` | — | Output format. |
| `--apply` | boolean | `false` | — | Commit the planned change; otherwise preview. |
| `--target` | records/scopes | — | 必填 | Explicit enrichment target. |
| `--limit` | integer | — | ≥ 1 | Records: 1000; scopes: 50; sender-only: 50 (maximum 100). |
| `--probe-apps` | boolean | `false` | — | Force application-name probes; records only. |
| `--unsafe-details` | boolean | `false` | — | Include private lookup details; records only. |
| `--sender-only` | boolean | `false` | — | Bounded lookup of one exact sender; requires --sender-id. |
| `--sender-id` | string | — | — | Exact sender for --sender-only. |

### maintenance repair

Preview structural recovery; apply uses existing fences.

默认效果：`local-read`；输出：`public-safe`。

| 显式模式 | 附加效果或输出级别 |
| --- | --- |
| `--apply` | database-write |

| 参数 | 类型/取值 | 默认 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `--db` | path | `data/exocortex.sqlite` | — | Database; default relative to installation root, explicit relative paths to cwd. |
| `--format` | text/json | `text` | — | Output format. |
| `--apply` | boolean | `false` | — | Commit the planned change; otherwise preview. |

### maintenance replay

Preview replay of explicit scopes and a fixed interval.

默认效果：`local-read, remote-read`；输出：`public-safe`。

| 显式模式 | 附加效果或输出级别 |
| --- | --- |
| `--apply` | database-write |

| 参数 | 类型/取值 | 默认 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `--db` | path | — | 必填 | Database; default relative to installation root, explicit relative paths to cwd. |
| `--format` | text/json | `text` | — | Output format. |
| `--apply` | boolean | `false` | — | Commit the planned change; otherwise preview. |
| `--scope-id` | string | — | 必填；可重复 | One to three distinct stored scopes; repeat this flag. |
| `--start` | string | — | 必填 | Explicit replay start with timezone. |
| `--end` | string | — | 必填 | Explicit replay end with timezone. |

### maintenance prune-runs

Preview run-history retention; applying can remove coverage evidence.

默认效果：`local-read`；输出：`public-safe`。

| 显式模式 | 附加效果或输出级别 |
| --- | --- |
| `--apply` | database-write |

| 参数 | 类型/取值 | 默认 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `--db` | path | `data/exocortex.sqlite` | — | Database; default relative to installation root, explicit relative paths to cwd. |
| `--format` | text/json | `text` | — | Output format. |
| `--apply` | boolean | `false` | — | Commit the planned change; otherwise preview. |

### maintenance compact

Preview database compaction; --apply permits the write.

默认效果：`local-read`；输出：`public-safe`。

| 显式模式 | 附加效果或输出级别 |
| --- | --- |
| `--apply` | database-write |

| 参数 | 类型/取值 | 默认 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `--db` | path | `data/exocortex.sqlite` | — | Database; default relative to installation root, explicit relative paths to cwd. |
| `--format` | text/json | `text` | — | Output format. |
| `--apply` | boolean | `false` | — | Commit the planned change; otherwise preview. |
<!-- END GENERATED options -->

## Cross-option and result contracts

- `status --lines` 仅用于 `--logs`，日志模式整份输出按 private 处理。status 读取成功返回 0，不证明同步完整。
- check 的 live 采样参数、cache 与 unsafe-details 仅用于 `--live`；timeout/poll 仅用于 `--wait`。backup 与 latest-backup 互斥。check 不提供 restart、kind、only 或自动全选模式。
- 默认 check 只查 database/sync/quality；请求的每一项都通过才返回 0，有效但未满足或证据不足为 2，参数、依赖或读取失败为 1。显式副本验证在源库失败时仍独立返回 backup 结果。
- service install 只保存配置；start 不强制更换已运行实例；restart 才明确重启。安装配置的参数关系由共同 WorkerConfig 校验，once/max-cycles 不允许固化。
- enrich 必须指定 records 或 scopes；limit 默认分别为 1000、50，sender-only 为 50 且上限 100。probe-apps、unsafe-details、sender-only/sender-id 属于 records 模式。预览仍可能读取远端，apply 才提交。
- replay 必须显式 DB、1–3 个不同 scope、带时区的固定 start/end；起点不得早于持久基线，终点不得晚于调用时刻。
- init/backup 是明确写动词；其他维护动作默认预览。全局 apply 不存在，apply 不放宽范围、lease、身份或版本/CAS 校验。
- 写命令完成为 0，明确部分失败或欠账为 2，无法执行为 1。sync 只输出既有 JSON summary；messages JSON 保持原数组及私有字段。
