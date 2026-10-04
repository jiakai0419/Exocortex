# Lark CLI capability research

研究工具用于观察 CLI 的身份、字段、分页与时间边界，不构成生产同步或健康证明。现行入口是 `tools/probes/capabilities.mjs` 和 `tools/probes/cursors.mjs`；完整选项、预算和私有输出规则见 [Development](development.md)。旧自动写报告及 no-live 隐含 events 的用法已退役，差异见 [CLI migration](cli-migration.md)。

## Capability modes

```sh
node tools/probes/capabilities.mjs --mode metadata
node tools/probes/capabilities.mjs --mode sample \
  --start "$PROBE_START_ISO" --end "$PROBE_END_ISO"
node tools/probes/capabilities.mjs --mode events --event-timeout 1s
```

metadata 是默认模式，不启动 events。sample 需要带时区、最长 24 小时的显式窗口；events 是单独有界会话，不隐藏在 metadata 中。默认只输出安全摘要；显式 `--output` 才写私有报告，路径由操作者决定。报告不提交仓库，不做真实或脱敏 fixture 来源。

## Cursor comparisons

```sh
node tools/probes/cursors.mjs --api native \
  --start "$PROBE_START_ISO" --end "$PROBE_END_ISO"
node tools/probes/cursors.mjs --api convenience \
  --start "$PROBE_START_ISO" --end "$PROBE_END_ISO"
```

native 是默认路径，convenience 只作显式对照，报告保留 api_family/version。实验观察顺序、包含式时间边界、has_more/page_token、过滤前后位置与计数；不能把一个 API 家族或一个样本的结果推广为全部会话、全历史或生产 cursor 证明。请求和输出有界且不自动重试，不因失败而悄悄扩窗或落完整报告。

## Questions that remain distinct

- 事件是否覆盖 user 身份可见消息，是否有足够的离线补偿；仅 bot 可见性不能代替用户态轮询。
- authored-by-me 是否能由可信自身份与消息搜索明确建立；身份缺失时不猜。
- received 是身份可读、非静音且属于所选会话类型、发送者不是本人的消息；不代表“已读”。
- 消息时间、分页顺序和稳定终点是否满足连续扫描；研究工具的输出不是成功窗口审计。

能够替代轮询的事件通道还需明确身份覆盖、稳定消息/会话/发送者/时间字段，以及可靠 replay、delta token 或同等 checkpoint。缺少任一证据时保持未知，不用低延迟观察取代同步内核的幂等、完整分页与原子 cursor 提交。
