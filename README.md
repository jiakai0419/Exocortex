# Exocortex / 衍我

[![CI](https://github.com/jiakai0419/Exocortex/actions/workflows/ci.yml/badge.svg)](https://github.com/jiakai0419/Exocortex/actions/workflows/ci.yml)

衍我是一个本地优先的外部认知系统。当前阶段只做一件事：

```text
可靠同步我的飞书消息流到本地。
```

当前同步范围：

- 我发过的飞书消息。
- 我收到的、来自非免打扰会话的飞书消息。

当前不做 UI、不做语义摘要、不建模“已读”。先把本地事实流做可靠。

## Core Commands

日常只需要记住三个命令：

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

## Current Status

后台同步通过 macOS LaunchAgent 运行。查看状态：

```bash
node scripts/lark-im-service.mjs status
```

查看最近同步到本地的消息：

```bash
node scripts/messages.mjs --limit 20
```

运行综合诊断：

```bash
node scripts/doctor.mjs
```

## Documents

- [Product note](docs/product.md)
- [V0 baseline](docs/v0-baseline.md)
- [Operations](docs/operations.md)
- [Ingestion core design](docs/ingestion-core-design.md)
- [Terminal experience](docs/terminal-experience.md)
- [Sync core hardening plan](docs/sync-core-hardening-plan.md)
- [Lark capability probe](docs/lark-capability-probe.md)

## Development

```bash
npm test
npm run check
```

The default interface is terminal-first. Internal scripts remain available through the full command catalog, but README intentionally stays small.
