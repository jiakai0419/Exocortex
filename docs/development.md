# Development and research tools

公共产品入口为 `node bin/exocortex.mjs`；开发工具不进入产品根帮助。日常操作见 [Operations](operations.md)，迁移状态见 [CLI migration](cli-migration.md)。所有测试输入从零合成，不读取账号、真实库、日志或脱敏业务样例。

## Prerequisites and verification

使用 Node.js 22、npm、SQLite CLI 3.35 或更新版本（包含 JSON 函数）及 Python 3。在隔离 checkout 安装 lockfile 依赖后验证：

```sh
npm ci
npm run verify
```

`tools/verify.mjs` 首先独立临时构建，与当前 dist 的完整文件集合及内容比较；通过后才顺序执行一次普通 TypeScript build、typecheck、语法发现、全部 Node 测试文件（最多四个文件并行，含 Python 覆盖测试）。生成物检查不改当前 dist，缺失或陈旧输出会在普通 build 写入前失败，不能靠验证过程自动修复而通过。一次完整 verify 共进行一次临时编译和一次普通 build，任一步失败停止。它不控制服务、不写真实数据库、不做真实账号验收。

| npm 任务 | 用途与效果 |
| --- | --- |
| `npm run build` | 按 tsconfig.build 生成当前 dist，生成物随源码提交 |
| `npm run typecheck` | noEmit 类型检查，覆盖 bin、tools、src |
| `npm run check` | 先 build，再运行源码语法发现 |
| `npm test` | 先 build，再完整运行 tests/*.test.mjs，最多四个文件并行 |
| `npm run build:check` | `tools/verify.mjs --generated-only`：临时干净构建、集合/字节比较，不修复当前 dist |
| `npm run verify` | 先独立临时编译并检查当前生成物，通过后执行一次普通 build 及类型、语法、全量测试 |

缺失声明、陈旧内容、孤立生成文件都应使 build:check 和 verify 失败，且保持当前 dist 不变；Git 中 dist 干净不等于输出正确。修改源码后先显式执行 `npm run build` 更新生成物，再执行 verify；源码与生成物一并提交。普通 build 不负责移除不再生成的孤立文件，删除源模块时同时处理对应旧生成物。不要在运行中的 checkout 执行会构建 dist 的任务。

### macOS CI

唯一完整 CI job `Check and test` 使用标准 `macos-26` ARM64 runner，保留 Node.js 22、`npm ci` 和完整 `npm run verify`，不另设 Linux 全量矩阵。测试仍最多四个文件并行，job 上限仍为 10 分钟，不因平台跳过测试。

CI 通过临时命令目录明确选择 `/usr/bin/python3` 与 `/usr/bin/sqlite3`，不遮蔽 `setup-node` 提供的 Node。预检输出系统、架构及依赖路径和版本，确认 Python 3.9+、`fcntl.flock`/非阻塞 FD、Python SQLite 的 JSON/schema 查询，以及 SQLite CLI 3.35+ 的 JSON 输出、JSON 函数、MATERIALIZED、RETURNING 和只读参数。完整性能力使用从零生成的临时 CHECK 违规库，验证产品所用的只读源 URI、一致性恢复和临时库检查能识别违规，并确认源文件不变；其他数据库探测使用 `:memory:`。系统依赖缺失或能力不符会失败，不自动升级系统工具。

完整测试使用合成数据、临时文件和测试自有进程；CI 不配置业务凭据、不调用真实飞书 API、不读取个人数据库。macOS 上的进程、锁、权限和 SQLite 回归不等于用户机器的实际验收：现有 launchd/Keychain 测试仍使用模拟，真实 LaunchAgent、登录权限和账号关联按 Operations 单独验收。

本机 Documents 目录中的新合成文件可能在创建后才被赋予 Darwin `UF_TRACKED`（文档 ID 跟踪标志），同时改变 `ctime`。姓名侧车夹具在发布给读取命令前，使用测试专用 helper 同步设置这个标志并验证其他身份字段不变；失败即中止，不等待静默期或重试命令。生产读取器仍严格比较 `ctime`。真实权限往返修改、同长度内容改写后恢复 `mtime` 的回归必须拒绝旧的配置快照，不能用放宽元数据比较来消除测试波动。

维护 CLI 的假 API 回归经 `tests/helpers/enrichment-cli.mjs` 运行真实 parser、维护入口、transport 和 flock/cooldown，将 API 协调目录显式注入夹具内，绝不接触当前 UID 的生产共享目录。测试入口要求数据库及假 CLI 属于同一合成根；只把请求间隔转换为同一单调时钟上的虚拟时间，真实子进程耗时仍计入预算。会话反例需检查实际 spawn 次数、释放锁前发布冷却、同步在间隔取得锁、解析到部分结果后预算耗尽仍没有业务提交。跨调用 fixture 不能通过关闭冷却或持久锁机制获得通过。

## Four development and research entrypoints

| 可执行文件 | 能力 |
| --- | --- |
| `tools/check-syntax.mjs` | 发现源码并做语法检查，显式文件参数用于局部检查 |
| `tools/verify.mjs` | 完整本地验证或单独生成物对照，无服务操作 |
| `tools/probes/capabilities.mjs` | 研究 CLI metadata、受限消息样本或显式 events |
| `tools/probes/cursors.mjs` | 研究 native 分页/时间契约，convenience 作为显式对照 |

生成物比较位于普通模块 `src/development/generated-check.mjs`，不是额外入口。研究工具共享受限执行/输出基础设施，不能把实验观察直接当作生产游标规则。

以下窗口与路径是新造示例，不能作为真实环境验收时刻：

```sh
node tools/probes/capabilities.mjs --mode metadata
node tools/probes/capabilities.mjs --mode sample \
  --start 2030-01-01T00:00:00Z --end 2030-01-01T01:00:00Z
node tools/probes/capabilities.mjs --mode events --event-timeout 1s
node tools/probes/cursors.mjs --api native \
  --start 2030-01-01T00:00:00Z --end 2030-01-01T01:00:00Z
node tools/probes/cursors.mjs --api convenience \
  --start 2030-01-01T00:00:00Z --end 2030-01-01T01:00:00Z \
  --output /tmp/exo-demo/private/cursors.json
```

Capabilities 默认 metadata，不启动 event 命令；sample 必须显式起止时间。events 显式进行两个身份会话，每个至多一个事件，event-timeout 范围 1s–5s。Cursors 默认 native，报告标明 api_family/version；两个 API 家族的观察不混合。样本/游标窗口必须带时区且不超过 24 小时。每次 CLI 调用最多 10 秒、20 MiB 输出，不自动重试，以保留首次异常。

窗口参数必须是有效的带时区 ISO 日历时间；不存在的日期在任何请求前拒绝。Cursor 边界探针只使用用户窗口内的有效响应时间（包含起点，不包含终点），异常、窗外或无法解析的时间保留为观察证据并跳过该后续请求；安全摘要标记 incomplete，退出码为 2。服务返回值不能扩大用户指定的窗口，也不能生成倒置或零宽请求。

默认只输出安全摘要，不自动落盘；仅 `--output` 新建 0600 的私有完整报告。完整报告可能含身份参数、正文或错误上下文，不提交、不发布、不转换成 fixture。无 output 不表示不联网：sample/events/cursors 都要求明确的账号读取授权，metadata 只做其登记的元数据探测。完整研究目的见 [Capability research](lark-capability-probe.md)。

## Internal executable tools

内部 worker 为 `src/runtime/worker/main.mjs`，服务安装器指向同一路径。开发者需要有限周期调度调试时可用 `--once` 或 `--max-cycles`，配合合成依赖和测试库；不把这些参数写进长期服务配置。

worker 一周期包含 sent、发现、hot/fair、reconcile 和周期维护，**不等价于公共 sync 的 scope=all**。单轮子进程使用 bin sync，周期 retention 使用 bin maintenance prune-runs --apply，保留 timeout、取消、JSONL 与退出契约。

`tools/coverage/lark-im-coverage-check.py` 是唯一覆盖实现，由公共 `check --through` 按需调用并传已解析 DB。不要另做 Node 版覆盖算法，也不要把 Python 文件移动后的 cwd 当作默认库来源。两个内部入口不计入四个开发/研究入口。

## Command documentation

`src/cli/registry.mjs` 是公共路由、选项、默认值、效果和输出级别的唯一目录。命令实现懒加载，帮助应在缺 DB、凭据、Python 和 dist 时也可发现。修改公共选项后同步 [命令目录](commands.md)，使用机器目录核对：

```sh
node bin/exocortex.mjs --help --all --format json
```

机器 JSON 直接调用 Node，避免 npm 的前缀。不要通过枚举文件把模块和研究工具当成公共命令，也不要为已退役 wrapper 复制业务规则表。领域反例仍测试真实实现；CLI 测参数、接线、效果与输出。

命令目录中的 Routes 和 Options 区块由 `src/development/command-docs.mjs` 的纯渲染函数从 registry 生成。catalog 测试逐字比较这两个区块，并检查组数和路由数；修改 summary、选项说明、默认值、约束、效果或输出级别而未同步文档时，完整 verify 必须失败。手写帮助示例与跨选项契约保留在生成区块之外；维护独立单元预览复用公共 maintenance 组；不增加独立可执行脚本。

`check --live` 的测试夹具注入正式的一次性采样器或共享调度器，并使用 v3 报告。测试失败、未到期、缓存写入和隐私边界时，必须经过与产品相同的接线；不能为旧 fixture 保留另一套 collector/writer 分支。旧缓存读取兼容单独使用从零合成的 v1/v2 文件验证，不依赖已退役的写入器。
