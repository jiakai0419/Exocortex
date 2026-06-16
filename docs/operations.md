# Exocortex Operations

这份文档回答一个问题：

```text
我每天怎么知道衍我同步系统是不是正常？
```

当前系统仍是 terminal-first。日常入口必须极简，诊断入口可以更完整，但不应该污染日常心智。

## Daily Commands

日常只需要记住三个命令：

```bash
npm run help
```

查看核心命令入口。

```bash
node scripts/messages.mjs --limit 20
```

查看最近同步到本地的消息。

```bash
node scripts/lark-im-service.mjs status
```

查看后台同步服务是否在运行，以及当前同步状态。

完整命令目录只在需要时查看：

```bash
npm run help -- --all
```

## Health States

### OK / FRESH

本地状态健康。已知范围内的同步 cursor 都已经推进到稳定状态。

### SYNCING

worker 正在执行某个同步 step。

这通常是正常状态，不代表故障。可以稍后再看：

```bash
node scripts/lark-im-service.mjs status
```

### CATCHING UP

初始同步还在追历史范围，或者 discovery 还没有扫完所有非免打扰会话。

这也是正常状态。当前阶段最常见的原因是：

```text
received_without_cursor > 0
```

也就是还有一些非免打扰会话没有建立初始 cursor。

### UNAVAILABLE

目前只用于 live probe。

典型情况：

```text
doctor --live 在当前 shell 中读不到 macOS keychain
```

这不等价于后台同步失败。后台 LaunchAgent 可能仍然能正常访问 `lark-cli` 登录态。

### DELAYED

live probe 发现远端热消息还没有全部进入本地。

如果只是短暂出现，可以等一两个 worker cycle 后再看。如果持续存在，再查日志。

### NEEDS ATTENTION

需要处理。常见原因：

- 本地状态命令失败。
- 本地质量检查失败。
- live probe 出现真实远端 API 错误。
- 数据质量出现 missing user sender name 或 invalid body。

## Initial Catch-Up Done

第一阶段同步基线完成，需要满足：

```text
received_without_cursor = 0
discovery.has_more = false
doctor 不再显示 CATCHING UP
```

可以用：

```bash
node scripts/doctor.mjs
```

或者查看机器可读状态：

```bash
node scripts/sync-status.mjs --format json
```

## Restart After Downtime

同步器必须假设自己可能很久没有正常运行。重启后的目标不是“从现在开始同步”，而是：

```text
从每个 Scope 上次持久化 Cursor 继续追赶到当前稳定边界
```

正常恢复路径：

1. `sent_by_me` 从自己的 Cursor 继续拉取我在停摆期间发出的消息。
2. 已知 `received.chat.*` 从各自 Cursor 继续拉取停摆期间收到的消息。
3. `discover-hot` 继续扫描最近活跃会话，发现新的活跃非免打扰会话。
4. 未完成的 full discovery snapshot 用持久化 `page_token` 继续扫后续页。

重启后短时间出现 `SYNCING` 或 `CATCHING UP` 是正常的。需要重点看：

```text
received_without_cursor 是否下降
discovery.has_more 是否最终变成 false
locks 是否长期不释放
最近失败是否还在重复出现
```

完成初始 catch-up 后，系统会通过独立的 periodic full reconcile 机制，定期完整盘点非免打扰会话集合。这个机制使用独立 Scope，不应该把已完成初始同步的系统长期显示为 `CATCHING UP`。

发现通道当前分三层：

```text
initial full discovery -> 建立第一份完整非免打扰会话集合
hot discovery          -> 每轮扫描最近活跃会话，尽快发现热会话变化
periodic reconcile     -> 定期完整复核会话集合，处理冷门会话和免打扰变化
```

它们分别使用独立 Scope。`hot discovery` 正常运行不应该覆盖 initial full discovery 的完成状态。

## When Something Looks Wrong

先看总状态：

```bash
node scripts/doctor.mjs
```

如果想对比远端热消息：

```bash
node scripts/doctor.mjs --live
```

如果 `--live` 显示 `UNAVAILABLE / keychain_unavailable`，说明当前 shell 读不到 keychain。它不是同步系统故障。需要真实 live 验证时，在能访问 keychain 的普通终端环境里运行同一个命令。

`doctor --live` / `lark-im-lag-check` 的真实验收使用本机飞书数据，但仓库里的自动化测试只使用 anonymized shape fixtures。它们保留飞书响应字段形状，不保留真实 ID、人名、群名、链接或消息正文。

看后台服务：

```bash
node scripts/lark-im-service.mjs status
```

`status` 会同时展示三层信息：

```text
LaunchAgent -> 后台服务是否被 macOS 托管、PID、退出码
Sync        -> 本地同步状态、records、scopes、discovery/reconcile
Worker      -> 最近完整 cycle、最近 step、是否正在跑、最近失败、日志路径
```

看最近 worker 日志：

```bash
node scripts/lark-im-service.mjs tail
```

重启后台服务：

```bash
node scripts/lark-im-service.mjs restart
```

## Acceptance Check

当前 v0 验收结论见 `docs/v0-baseline.md`。

当初始 catch-up 完成，v0 可以用这组命令验收：

```bash
npm test
npm run check
node scripts/doctor.mjs
node scripts/doctor.mjs --live
node scripts/messages.mjs --limit 20
node scripts/lark-im-service.mjs status
```

预期：

- 测试和检查通过。
- `doctor` 不显示 `NEEDS ATTENTION`。
- `doctor --live` 在可访问 keychain 的环境里是 healthy，或者没有缺失远端热消息。
- `sync-status` 中 `Discovery`、`Hot discovery`、`Reconcile` 分别能看出 initial、hot 和周期复核状态。
- `lark-im-service status` 中 `Worker` 区域能看出最近 cycle 在持续推进。
- 最近消息能正常展示发送人、群名和消息内容。
- 后台服务是 active。

## Boundaries

当前不做：

- UI。
- 语义摘要。
- embedding。
- “已读”建模。
- 新信息源接入。

这些都应该等飞书消息同步基线稳定后再继续。
