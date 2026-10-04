# Terminal Experience

衍我当前采用 terminal-first。Terminal 不是临时壳子，而是主要交互界面。

## 调研结论

参考：

- [Command Line Interface Guidelines](https://clig.dev/)
- [Node.js `util.styleText`](https://nodejs.org/api/util.html#utilstyletextformat-text-options)
- [NO_COLOR](https://no-color.org/)
- [Chalk](https://github.com/chalk/chalk)
- [Inquirer](https://github.com/SBoudrias/Inquirer.js)
- [Ink](https://github.com/vadimdemedes/ink)

我们当前不引入 TUI 或交互 prompt 框架。理由：

- 当前核心是信息同步、诊断和读取，不是复杂交互。
- Node 自带 `util.styleText` 已能处理 TTY、`NO_COLOR`、`FORCE_COLOR` 等颜色语义。
- 无依赖脚本更适合后台服务、自动化、测试和长期维护。
- 过早引入 TUI 容易把注意力从同步正确性拉走。

## 输出原则

1. 默认输出给人看，`--format json` 给机器读。
2. 日常入口极简，完整目录由 registry 生成，在 `npm run help -- --all` 查看；机器发现使用 `node bin/exocortex.mjs --help --all --format json`。
3. 命令、状态和关键数字要一眼可见。
4. 颜色只用于扫描：命令、状态、分组、提示。
5. 支持纯文本退化，不能依赖颜色表达唯一含义。
6. 错误和诊断要给下一步动作，不只 dump 堆栈。
7. 后台/同步类命令优先展示当前状态，再展示细节。
8. 数据查看类命令优先展示事实本身，再展示元数据。

## 项目内实现

共享渲染层：

```text
dist/terminal/index.js
```

所有面向人的 terminal 输出应优先使用这里的函数：

- `title`
- `section`
- `command`
- `statusBadge`
- `kv`
- `table`
- `list`
- `hint`
- `compact`

命令可以保留 JSON 输出，但 text 输出应尽量走共享渲染层。

## 改造范围

面向人的命令使用共享渲染层：

- `--help`
- `messages`
- `status` / `status --detail` / `status --logs`
- `check` 及显式的 live、coverage、backup、wait 扩展
- `service` 的五种生命周期动作
- `maintenance` 的七种维护动作

内部命令可以继续优先输出 JSON/JSONL：

- worker 日志
- 单轮 sync summary
- enrichment 批处理 summary
- capability/cursor probe report

这些命令的输出常被其他脚本读取，机器可读性优先于视觉优化。

## 卡片消息

共同规则及合成验收矩阵见 [卡片与身份投影设计](card-and-identity-projection.md)；展示不能按业务截图特判。

`messages` 的卡片在消息标签下缩进显示多行标题、正文、字段与导航按钮，使用受限解析结果 `display.card`，不经过 `compact`。展示版本为 3，`br` 节点和独立块边界显示为换行，行内节点及有语义的尾部文本保留原顺序；明确没有可用导航链接的动作按钮默认收起，有安全 HTTP(S) 地址的导航按钮仍显示，包括原生 `link.url = {url: string}` 包装，不执行按钮或访问地址。收起按钮不表示动作已完成，完整节点仍在 raw 中。

姓名仅来自同条消息的明确证据：直接匹配 `mentions`，或通过 `json_attachment.at_users` 中的显式引用映射连接到 `mentions`。没有匹配时就地显示未知提及占位；若这就是唯一缺失，不重复追加整行通用说明，JSON 仍保留 `partial` 和对应 `reason`。未知可见结构、无效链接和解析超限等其他关键缺失继续提示，不退回原始 JSON。整段内容先清除终端控制序列再分行，避免控制序列跨行逃逸。普通消息仍沿用原来的紧凑显示。

JSON 消费者原有字段不变，`display.card` 是可选增量；原始内容仍在 raw 字段。阅读只重建本地快照的展示，不联网、不回写，也不证明客户端中的实时审批状态。按创建时间前进的普通同步不会自动刷新旧卡片，合并转发详情重试也不覆盖普通卡片。数据、状态核查与链接的完整契约见 [卡片阅读与原始数据契约](operations.md#卡片阅读与原始数据契约)。

## 服务状态

公共 `status` 的整屏契约见 [Status screen design](status-screen-design.md)。默认按 Health & current work、Coverage、Attention、Recent history 分组，`--detail` 保持结构并增加 Diagnostics。正常 80 列无色合成屏约 31 行；窄屏折行并堆叠标签，不裁掉诊断事实。颜色只加强层级，不承载唯一含义。

Current work 只取已验证的阶段、实例、数据库和时间证据；缺失或冲突显示 Unconfirmed 加具体原因。JSON 中的 syncing/waiting/stopped/unknown 与既有兼容字段不变。完成任务、未收尾轮次、正常锁都不能冒充当前活动。[Activity 证据](activity-evidence.md) 保留判定边界。

Coverage 分开会话名单、收到的会话、所有消息源、列表水位与内容欠账；名单完成或有游标不等于全量远端覆盖。Restricted chats 按数量、原因及有效错误码展示；未知原因不复制原始错误。远端采样单独说明缓存、样本范围和身份限制。

Recent history 明示 worker 日志未验证属于所选数据库，日志窗口内的周期/任务和数据库内按开始时间统计的失败运行各有时间口径。无事件、无日志、截断、不可查询不会统称为没有失败；完整窗口、最长成功间隔、旧任务和未收尾历史在 detail 中可查。所有时间统一到声明的本地时区，跨日和 DST 保留必要端点信息。
