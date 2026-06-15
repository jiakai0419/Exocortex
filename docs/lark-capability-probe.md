# Lark CLI Capability Probe

这个 probe 的目的不是证明我们脑中的方案正确，而是把 `lark-cli` 对飞书 IM 的真实能力边界跑出来，作为 Exocortex / 衍我的第一版同步设计依据。

## 关注问题

1. 消息如何同步到 Exocortex：
   - 事件推送：`lark-cli event consume ...`
   - 用户态查询：`lark-cli im +messages-search` / `+chat-messages-list`
   - 如果事件通道覆盖用户视角、所有会话、且有可靠补偿，就可以减少甚至取消轮询。
   - 如果事件通道只覆盖 bot 视角，用户态轮询仍然是主路径，事件最多作为低延迟增量。

2. 我发送过的消息如何实现：
   - 探针先用 `lark-cli contact +get-user --as user` 获取当前用户 open_id。
   - 再用 `lark-cli im +messages-search --as user --sender <self_open_id>` 验证是否能查询 authored-by-me。

3. 我收到过的消息如何实现：
   - 当前阶段不建模“已读”。
   - `received` 的第一版定义是：用户身份可拉取、发送者不是我、且来自非免打扰会话的消息。
   - 默认纳入非免打扰群聊和私聊：`--chat-types group,p2p`。

## 低隐私原则

默认 probe 不保存：

- 消息正文
- 群名 / 单聊对象名
- 联系人姓名
- 完整 open_id

默认 probe 保存：

- 命令是否成功
- endpoint / dry-run 信息
- auth types / scopes
- 返回对象的字段名
- 结果数量
- 是否出现 `read` / `unread` / `last` / `cursor` / `badge` 这类字段名

## 使用方法

```bash
node scripts/lark-capability-probe.mjs
```

输出会写入：

```text
reports/lark-capabilities/lark-capability-probe-<timestamp>.json
```

可选参数：

```bash
node scripts/lark-capability-probe.mjs \
  --start 2026-06-13T00:00:00+08:00 \
  --end 2026-06-13T23:59:59+08:00
```

如果只想看 schema / dry-run / event identity 验证，不触发用户消息字段探针：

```bash
node scripts/lark-capability-probe.mjs --no-live
```

## Cursor probe

消息同步实现前，还需要单独验证飞书 IM 的时间边界和分页语义：

```bash
node scripts/lark-im-cursor-probe.mjs
```

这个 probe 会检查：

- `+messages-search` 查询我发出的消息时，返回顺序是否能作为 cursor 推进依据。
- `+chat-messages-list --order asc` 是否按 `create_time` 单调递增。
- `--start` 时间边界是否包含边界消息。
- `has_more` / `page_token` 是否可用于连续分页。
- `+chat-list --exclude-muted` 是否需要跨页枚举才能找到非免打扰会话。

输出同样写入：

```text
reports/lark-capabilities/lark-im-cursor-probe-<timestamp>.json
```

报告只保存 hash 后的 ID、时间戳、页信息和判断结果，不保存消息正文、群名或联系人名。

## 判定标准

### 实时事件能否替代轮询

可以替代轮询需要同时满足：

- IM message receive 事件支持 `user` 身份，或者等价地覆盖当前用户所有可见会话。
- 事件 payload 有稳定的 `message_id` / `chat_id` / `sender_id` / `create_time`。
- 有官方 replay、delta token 或等价 checkpoint 机制，能覆盖进程离线、网络抖动、权限变化期间的事件连续性。

不满足时，推荐：

- 用户态查询作为真相来源，并由核心同步层的 Cursor、幂等写入和原子提交保证推进正确。
- 事件推送作为低延迟增量，只覆盖它能看见的会话。

### authored-by-me

优先路径：

```text
contact +get-user --as user
  -> open_id
  -> im +messages-search --as user --sender <open_id>
```

这个路径成立时，第一版可以把“我发送过的消息”作为可靠能力。

### received

当前阶段的 received 不等于已读。它的定义是：

```text
message sender != me
AND chat is not muted
AND chat is within the selected chat types
```

默认 chat types 是 `group,p2p`。这让第一版覆盖“我发过的”和“我收到过的”，但仍不引入已读模型。
