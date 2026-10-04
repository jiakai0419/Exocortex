# Sync Core Hardening Plan

> 历史规划：本文保留早期阶段目标和验收设想，不是当前实现清单或运行状态。现行操作见 [Operations](operations.md)，事务与来源边界见 [Storage contracts](storage-contracts.md)，已实现反例见 [Node reliability fixes](node-reliability-fixes.md)。下文的“当前”“下一阶段”均指写作时点。

## 当前判断

衍我当前阶段的核心不是 UI、摘要、embedding 或新信息源，而是把飞书消息同步做成可以长期依赖的事实流。

现状：

- 后台 worker 已经能持续运行。
- 本地 SQLite schema 已经有 Source / Scope / Record / Run / Lock。
- Terminal-first 已经成为交互原则。
- `npm test` 已经覆盖了一部分 cursor 和事务语义。
- `scripts/lark-im-sync.mjs` 已收敛为稳定入口和兼容 re-export；CLI command、sync runner、adapter、store、core、worker 和 diagnostics 已有清晰边界。

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
- fair steady-state lane 按最旧 cursor 更新时间轮转所有已知 scope，hot rank 不能造成饥饿。
- doctor 能区分 syncing / catching_up / needs_attention。
