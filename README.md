# Exocortex / 衍我

[![CI](https://github.com/jiakai0419/Exocortex/actions/workflows/ci.yml/badge.svg)](https://github.com/jiakai0419/Exocortex/actions/workflows/ci.yml)

衍我是一个本地优先的飞书消息同步工具，使用 Node.js、TypeScript、官方 lark-cli 和 SQLite。消息、游标和运行数据留在本地；仓库用于代码和通用说明。新测试输入必须从零合成，不提交真实运行数据或其脱敏派生样例。

## Development

需要 Node.js 22、npm、SQLite CLI 3.35 或更新版本（含 JSON 函数）和 Python 3。

```sh
npm ci
npm run build
npm run typecheck
npm run check
npm test
```

生成的 `dist` 随源码提交；`npm run build:check` 在干净临时目录构建，比较完整文件集合与内容，发现缺失、过时和孤立产物，且不改当前 `dist`。修改源码后先运行 `npm run build`，移除不再生成的文件，再执行检查。自动化测试使用假请求和新建的临时数据库，不需要真实账号、凭据或聊天数据。

## Commands

```sh
npm run help
node scripts/messages.mjs --limit 20
node scripts/lark-im-service.mjs status
node scripts/doctor.mjs
```

`messages` 是本机私有内容阅读入口。默认诊断不联网、不初始化数据库、不恢复 stale run、不 chmod、不写 freshness cache；`doctor --live` 会读取远端，写采样缓存还需要显式 `--write-live-cache`。本地 `LOCAL_READY` 和有界 `SAMPLED` 不能证明全历史完整性。

显式 `--start` 必须是带时区的 ISO 时间，并持久保存为来源基线。空新库省略该参数时，首次运行使用当日本地零点并持久化；已有数据但没有基线的旧库必须显式确认。后续新发现或跨日仍无 cursor 的 scope 复用同一基线；已有 cursor 优先。不同的 `--start` 不能改写已有基线。

```sh
python3 -B scripts/lark-im-coverage-check.py --target "$COVERAGE_TARGET_ISO"
```

覆盖检查从已有数据库读取基线，以显式固定终点检查保留的成功窗口证据。它不会创建数据库；退出码 `2` 表示未完成或检查错误。真实同步和部署需分别验收。

## Node Behavior

- 同步记录、统计和游标在事务内提交，校验运行租约与版本。默认只读诊断不恢复遗留状态；手动修复使用 `sync-repair --apply`，同步写路径取得 scope 锁前仍会自动检查并恢复该 scope 的 stale 状态。
- 备份先验证再发布，自动清理仅处理同一来源的有效备份。
- received 使用原生分页并包含主题回复；sent 使用搜索与 mget 核对详情；原始内容和主题关系保留。
- 合并转发详情失败不禁用整个会话：完整列表中的普通消息、逐根详情待办与列表进度原子保存；列表可继续向前，完整内容游标仅在欠账清零后闭合。支持 `--scope details` 有界独立补齐。列表窗口耗尽总时间预算后只再尝试一个最小前缀。
- service 区分未加载与无法确认，启动请求失败会报错；已结束的历史 step 不证明当前同步，活动需要当前阶段、匹配的进程实例与有限新鲜度证据；锁只证明互斥。
- 同步与姓名补全共用合并规则：同一身份的未知姓名保留已有值，明确清空与解析失败分开，缓存会话名不能覆盖已知或已清空姓名，同版本新证据改善仍可写入。
- hot/fair 队列轮转并保留公平容量。自适应为可选参数；操作组冷却与重试预算不等于逐 endpoint QPS 限流。

这些是代码能力，不能代替当前环境的运行验收。详细参数、默认值和边界见 [Operations](docs/operations.md)。共同规则见 [身份与内容投影](docs/card-and-identity-projection.md) 和 [Activity 证据](docs/activity-evidence.md)。

## Documents

- [Product note](docs/product.md)
- [Ingestion core design](docs/ingestion-core-design.md)
- [Sync hardening design](docs/sync-core-hardening-plan.md)
- [Language and module boundaries](docs/language-and-refactor-plan.md)
- [Terminal experience](docs/terminal-experience.md)
- [Node reliability fixes and regression evidence](docs/node-reliability-fixes.md)
- [Current storage and entrypoint contracts](docs/storage-contracts.md)
