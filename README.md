# Exocortex / 衍我

[![CI](https://github.com/jiakai0419/Exocortex/actions/workflows/ci.yml/badge.svg)](https://github.com/jiakai0419/Exocortex/actions/workflows/ci.yml)

衍我是一个本地优先的飞书消息同步工具，使用 Node.js、TypeScript、官方 lark-cli 和 SQLite。消息、游标和运行数据留在本地；仓库用于代码和通用说明。新测试输入必须从零合成，不提交真实运行数据或其脱敏派生样例。

## Daily commands

```sh
npm run help
npm run exo -- messages --limit 20
npm run exo -- status
```

`messages` 阅读本机私有消息；`status` 查看当前服务和同步概况。规范入口为 `node bin/exocortex.mjs`，`npm run exo --` 是本地快捷方式，无需全局安装。机器读取 JSON 时直接使用 Node 入口，避免 npm 前缀。

完整界面为 6 个顶层命令、16 个执行路由。帮助不计为业务路由，开发工具和内部 worker 不进入产品目录：

```sh
node bin/exocortex.mjs --help --all
node bin/exocortex.mjs check --help
node bin/exocortex.mjs --help --all --format json
```

[命令目录](docs/commands.md) 给出全部选项、默认值与副作用；[Operations](docs/operations.md) 给出检查、重启和验收配方；[CLI migration](docs/cli-migration.md) 记录旧路径去向、真实 worker 切换取证与部署验收边界。

## Checks and explicit changes

```sh
node bin/exocortex.mjs check
node bin/exocortex.mjs status --detail --format json
node bin/exocortex.mjs service restart
node bin/exocortex.mjs check --wait
node bin/exocortex.mjs check --through "$COVERAGE_TARGET_ISO"
```

默认 `check` 聚合本地 database、sync、quality 证据，不要求服务运行，也不联网、建库、恢复遗留 run、chmod、写缓存或启停服务。`--wait` 等待调用后新的完整成功 worker 周期；`--through` 使用固定终点验证保留的覆盖证据。检查条件不满足返回 2，参数、依赖或读取失败返回 1；`status` 和 `messages` 读取成功返回 0，不证明同步完整。

`check --live` 显式读取有界远端样本；只有再加 `--write-live-cache` 才写缓存。`messages`、`status --logs` 和显式 `--unsafe-details` 输出属于私有内容。本地 ready 和有界 SAMPLED 都不能证明全历史完整。

显式 `sync --start` 必须带时区并持久保存为来源基线。空新库省略时首次运行使用当日本地零点；已有数据但缺基线的旧库必须显式确认。新发现或跨日仍无 cursor 的 scope 复用同一基线，已有 cursor 优先，不同的 `--start` 不能改写已有基线。

## Development

需要 Node.js 22、npm、SQLite CLI 3.35 或更新版本（含 JSON 函数）和 Python 3。先在隔离开发 checkout 执行：

```sh
npm ci
npm run verify
```

`verify` 完成 build、typecheck、syntax、全量测试与干净生成物对照，不启停服务。它会写当前 `dist`，不可用于运行中的 checkout。`npm run build:check` 只在临时目录构建并比较完整输出文件集合和内容，不改当前 `dist`。详细开发任务、研究工具及内部 worker 见 [Development](docs/development.md)。真实运行和部署另按 [Operations](docs/operations.md) 验收。

## Node Behavior

- 同步记录、统计和游标在事务内提交，校验运行租约与版本。默认只读诊断不恢复遗留状态；手动修复使用 `maintenance repair --apply`，同步写路径取得 scope 锁前仍会自动检查并恢复该 scope 的 stale 状态。
- 备份先验证再发布，自动清理仅处理同一来源的有效备份。
- received 使用原生分页并包含主题回复；sent 使用搜索与 mget 核对详情；原始内容和主题关系保留。
- 合并转发详情失败不禁用整个会话：完整列表中的普通消息、逐根详情待办与列表进度原子保存；列表可继续向前，完整内容游标仅在欠账清零后闭合。支持 `--scope details` 有界独立补齐。列表窗口耗尽总时间预算后只再尝试一个最小前缀。
- service 区分未加载与无法确认，启动请求失败会报错；已结束的历史 step 不证明当前同步，活动需要当前阶段、匹配的进程实例与有限新鲜度证据；锁只证明互斥。
- 同步与姓名补全共用合并规则：同一身份的未知姓名保留已有值，明确清空与解析失败分开，缓存会话名不能覆盖已知或已清空姓名，同版本新证据改善仍可写入。
- hot/fair 队列轮转并保留公平容量。自适应为可选参数；操作组冷却与重试预算不等于逐 endpoint QPS 限流。

这些是代码能力，不能代替当前环境的运行验收。详细参数、默认值和边界见 [Operations](docs/operations.md)。共同规则见 [身份与内容投影](docs/card-and-identity-projection.md) 和 [Activity 证据](docs/activity-evidence.md)。

## Documents

- [Operations](docs/operations.md)
- [Command catalog](docs/commands.md)
- [CLI migration](docs/cli-migration.md)
- [Development and research tools](docs/development.md)
- [Product note](docs/product.md)
- [Current storage contracts](docs/storage-contracts.md)
- [Terminal experience](docs/terminal-experience.md)
- [Reliability regression history](docs/node-reliability-fixes.md)
- [Historical ingestion design](docs/ingestion-core-design.md)
- [Historical sync hardening plan](docs/sync-core-hardening-plan.md)
- [Historical language and module plan](docs/language-and-refactor-plan.md)
