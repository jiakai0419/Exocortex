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

## 错误与检查输出契约

显式 `--format json` 的异常退出使用统一的 `schema_version: 1`、`ok: false`、`error: { code, message }` 封装；参数解析与命令内纯参数校验使用 `invalid_arguments`，执行失败使用 `execution_failed`。已知安全原因可保留在 `error.reason`，不输出原始依赖错误、远端 stderr、消息内容或路径。`sync` 的默认 JSON 模式也遵守此契约。成功结果及已有业务报告的 JSON 结构和退出码保持不变；文本错误继续写 stderr，transport 诊断仍只在 stderr。

worker 在子命令非零退出且没有 stderr 原因时，从已识别的错误封装提取 message 写入原有失败日志字段，避免结构化输出使排错信息消失；进程错误或信号优先，未知封装不解释为公开错误。

`sync` 和 `maintenance replay` 遇到 API 租约忙碌或不可用时均属于执行失败；有效命令无需改写参数，应保留具体租约原因及 `execution_failed` 分类。

`check --live` 文本在非健康样本时展示公开白名单中的具体原因，例如账号冲突、API 正忙、无可抽样会话或调度尚未到期；不以通用 `live_incomplete` 取代已有原因。身份冲突与未解决的历史观察等额外计数仅在非零时显示，不增加正常屏幕噪声。不添加通用操作提示，不改动检查的 JSON 证据、采样、缓存调度或退出码。纯合成回归必须同时验证文本保留异常原因、JSON 保留原字段，以及未知原因和私有哨兵不会泄露。

公开 live 文本只渲染 v3 的安全采样证据，不再调用旧 v2 lag renderer。`--unsafe-details` 不绕过 v3 的 `publicRemoteReport` 脱敏；此兼容选项不新增私有详情字段。

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

`messages` 默认标题后直接展示消息，不附排序说明或卡片快照提示。消息按发生时间倒序读取；卡片来自已采集 API 快照，可能与客户端当前状态不同，读取不联网、不回写；这些语义保留在 `messages --help`。默认文本视图省略程序生成的通用 partial 尾注及结构 `hr` 装饰线，`hr` 保留段落留白；真实正文中相同文字、Markdown/代码字面的 `---` 保留。未知提及、无正文 fallback 等具体位置证据保留；实际资源限额在触发位置用具体短标记说明，仍计入16,000字符总预算；JSON 的 `display.card.text`、`status`、`reason` 及 raw/canonical/body 不变。

姓名仅来自同条消息的明确证据：直接匹配 `mentions`，或通过 `json_attachment.at_users` 中的显式引用映射连接到 `mentions`。没有匹配时就地显示未知提及占位；若这就是唯一缺失，不重复追加整行通用说明，JSON 仍保留 `partial` 和对应 `reason`。JSON 保留未知结构、无效链接和解析超限的状态与原因；文本保留可解析正文和就地未知标记，不追加通用 partial 尾注，也不退回原始 JSON。整段内容先清除终端控制序列再分行，避免控制序列跨行逃逸。普通消息仍沿用原来的紧凑显示。

JSON 消费者原有字段不变，`display.card` 是可选增量；原始内容仍在 raw 字段。阅读只重建本地快照的展示，不联网、不回写，也不证明客户端中的实时审批状态。按创建时间前进的普通同步不会自动刷新旧卡片，合并转发详情重试也不覆盖普通卡片。数据、状态核查与链接的完整契约见 [卡片阅读与原始数据契约](operations.md#卡片阅读与原始数据契约)。

## 服务状态

公共 `status` 的整屏契约见 [Status screen design](status-screen-design.md)。默认按 Health & current work、Messages & progress 分组，附加异常才显示 Problems；正常 80 列无色合成屏为 13 行。`--detail` 增加 Background history 与 Diagnostics。窄屏折行并堆叠标签，颜色不承载唯一含义。

Current work 只取已验证的阶段、实例、数据库和时间证据；缺失或冲突显示 Unconfirmed 加具体原因。JSON 中 syncing/waiting/stopped/unknown 与既有兼容字段不变。未绑定日志中的成功或失败、未收尾轮次、正常锁均不能决定当前工作或本库健康。[Activity 证据](activity-evidence.md) 保留判定边界。

默认保留已知会话/内容待办与详情欠账，列表证据不可用或无效时仍显示。原始最旧水位仅在详情，不新增滚动列表计数或固定区间覆盖功能。收到的会话数量与包含全局发送源的详情来源数分开；存在检查点不代表连续内容覆盖。受限数量与排除范围合成一行，原因代码在详情；零数据库失败、正常关联证据与操作建议也在详情。

Background history 明示 worker 日志未验证属于所选数据库，窗口内周期/任务与数据库按开始时间统计的失败运行分开。未绑定日志历史全部只在详情显示，包括明确失败、失败计数、截断、旧结果和成功间隔。正数/未知数据库失败仍默认显示，使用独立时间窗。全部时间共享声明的本地时区，跨日和 DST 保留必要端点。
