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

### 列宽与续行

`messages`、`check` 与帮助文本使用输出流的列宽，非终端默认 80 列；40 列窄屏使用悬挂缩进，续行仍属于原来的字段或选项。正文、诊断事实和选项不因适配列宽而删除。长度计算按 Unicode 字素和终端格宽进行，不切断组合字符或 emoji；单个字素宽于可用列宽时完整保留。JSON、退出码和命令目录内容不受文本布局影响。

消息保留原有硬换行、卡片块边界、字面空白与列表关系。软折行不能压平正文，不能改变现有普通消息紧凑预算或卡片解析预算。长链接可以独立占行；不可在链接内部插入换行以免破坏复制。无法容纳正文的深层原始缩进保留原行；该行、长链接或单个字素可能超出列宽，不能为了宽度丢失源信息。正常宽屏保留原有标签和信息顺序，不恢复通用 partial 提示。

帮助的排版模块保持无业务依赖：缺少 dist、SQLite、Python 或账号凭据时帮助仍可读取。布局测试须经过真实 CLI/renderer，覆盖 80/40 列、纯文本/颜色、空结果、异常结果、Unicode、长字段和卡片显式换行，并验证 JSON 不变。

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

格宽和纯文本折行由无依赖的 `src/terminal/text-layout.mjs` 提供，状态、消息、帮助与检查共用同一字素宽度模型。调用方负责先净化、后着色；卡片使用保真单行分片，普通说明文字使用按词折行。不要把带 ANSI 的文本传给格宽工具，也不要把会规范化空白的说明文字模式用于卡片正文。

## 错误与检查输出契约

显式 `--format json` 的异常退出使用统一的 `schema_version: 1`、`ok: false`、`error: { code, message }` 封装；参数解析与命令内纯参数校验使用 `invalid_arguments`，执行失败使用 `execution_failed`。已知安全原因可保留在 `error.reason`，不输出原始依赖错误、远端 stderr、消息内容或路径。`sync` 的默认 JSON 模式也遵守此契约。成功结果及已有业务报告的 JSON 结构和退出码保持不变；文本错误继续写 stderr，transport 诊断仍只在 stderr。

worker 在子命令非零退出且没有 stderr 原因时，从已识别的错误封装提取 message 写入原有失败日志字段，避免结构化输出使排错信息消失；进程错误或信号优先，未知封装不解释为公开错误。

`sync` 和 `maintenance replay` 遇到 API 租约忙碌或不可用时均属于执行失败；有效命令无需改写参数，应保留具体租约原因及 `execution_failed` 分类。

`check --live` 文本在非健康样本时展示公开白名单中的具体原因，例如账号冲突、API 正忙、无可抽样会话或调度尚未到期；不以通用 `live_incomplete` 取代已有原因。身份冲突与未解决的历史观察等额外计数仅在非零时显示，不增加正常屏幕噪声。已采样结果的 JSON 证据、采样与缓存调度保持原契约。纯合成回归必须同时验证文本保留异常原因、JSON 保留原字段，以及未知原因和私有哨兵不会泄露。

公开 live 文本只渲染 v3 的安全采样证据，不再调用旧 v2 lag renderer。`--unsafe-details` 不绕过 v3 的 `publicRemoteReport` 脱敏；此兼容选项不新增私有详情字段。

`check --wait` 未完成时保留安全白名单中的具体等待原因，区分服务未运行或目标未确认、等待超时和最终本地检查未就绪。最终就绪要求新成功周期，以及数据库完整性、sync、quality 全部通过；数据库不完整时 wait 不能单独显示 passed，整体仍为 incomplete（exit 2）。依赖不可用沿 error（exit 1）处理；`--live` 缺少 Python 等必需程序时，JSON 的 `missing_dependencies` 和文本均明确列出安全程序名，不执行远端采样或写缓存。

普通正文保留原有 240 UTF-16 单位预算，超限时先回退到完整 Unicode 字素边界再加省略号；emoji、肤色、组合音标和 ZWJ 序列不会被截成半个字符。JSON 正文不截断。

系统消息的只读展示诊断位于可选 `display.system`，与 `display.body` 来自同一次渲染；历史 `canonical.content_rendering` 与 raw/body/canonical 不改写。源模板的显式参数优先。历史群名补全仍要求同一 chat、群类型和事件时间的明确来源证据。同条消息的 `chat_name` 与 `create_time` 仅构成消息快照，不证明事件当时群名。

明确容器语义的入群模板包括 `{name} joined {group_name}. New members can view all chat history.` 和 `{to_chatters} joined {group_name}. New members can view all chat history.`。当历史 `group_name` 真正缺失、消息身份和时间与存储行一致，且同一群的 `scope.config.chat_name` 可用时，展示为 `… joined this group (current local title: …). New members can view all chat history.`。这是当前本地会话标题的说明，不是填回历史事件群名；保留源模板的英语，不增加翻译流程。显式空或畸形参数、其他模板、身份或群类型冲突均不套用。

这条展示路径保留 `missing_parameters: ["group_name"]` 和 `status: "partial"`，历史 `context_parameters` 仍为空。独立 `current_group_context` 标明 `source: "scope_config"`、`time_basis: "current_local"`、标题和精确会话；终端同时显示“当前本地标题来源：会话配置；观察时间未知”，仅说明正文中的当前本地标题，原“群”字段仍可能显示历史消息快照标题。现有 scope 没有可靠的标题观察时间，因此 `observed_at` 为 `null`，不会用消息时间、scope 更新时间、hot-seen 时间或读取时刻代替。`scope.name` 是同步范围标识，不是群标题。`messages` 仍只读本地库，不联网、不写入或刷新范围配置。

原生明确非空群名优先于上下文。operator/name 不借用其他身份，参数只替换一次；会话的当前标题不会被记作 `message_event`。已有发送人名称也不会因这条系统消息展示规则改变。API 返回的名称、空联系人结果与客户端显示是不同证据，不能据此推断权限问题或替换另一条消息的姓名。

## 改造范围

面向人的命令使用共享渲染层：

- `--help`
- `messages`
- `status` / `status --detail` / `status --logs`
- `check` 及显式的 live、coverage、backup、wait 扩展
- `service` 的五种生命周期动作
- `maintenance` 的 10 种维护动作

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

公共 `status` 的整屏契约见 [Status screen design](status-screen-design.md)。默认按 Health & current work、Messages & progress 分组，附加异常才显示 Problems；完整合成输出见 [Synthetic status screens](status-screen-examples.md)。`--detail` 增加 Background history 与 Diagnostics。窄屏折行并堆叠标签，颜色不承载唯一含义。

Current work 只取已验证的阶段、实例、数据库和时间证据；缺失或冲突显示 Unconfirmed 加具体原因。JSON 中 syncing/waiting/stopped/unknown 与既有兼容字段不变。未绑定日志中的成功或失败、未收尾轮次、正常锁均不能决定当前工作或本库健康。[Activity 证据](activity-evidence.md) 保留判定边界。

Runs 的 total/successful 共用一个逻辑行，默认注明 current worker / retained log 范围；Last completed 的结果、时间和耗时来自同一个绑定完成事件并共用一个逻辑行。最后一轮未成功或请求 detail 时，分别说明消息同步、历史复查及到期清理的结果；未执行的可选步骤不显示成功，缺失原因不猜测。历史复查失败仍使整轮失败，不能因为消息同步成功而改写成功计数。详细契约见 [Runtime statistics](status-runtime-stats.md)。

默认保留已知会话/内容待办与详情欠账，列表证据不可用或无效时仍显示。原始最旧水位仅在详情，不新增滚动列表计数或固定区间覆盖功能。收到的会话数量与包含全局发送源的详情来源数分开；存在检查点不代表连续内容覆盖。受限数量与排除范围合成一行，原因代码在详情；零数据库失败、正常关联证据与操作建议也在详情。

Background history 明示 worker 日志未验证属于所选数据库，窗口内周期/任务与数据库按开始时间统计的失败运行分开。未绑定日志历史全部只在详情显示，包括明确失败、失败计数、截断、旧结果和成功间隔。正数/未知数据库失败仍默认显示，使用独立时间窗。全部时间共享声明的本地时区，跨日和 DST 保留必要端点。

worker 的 `history` 步骤显示为 Stored message history review，与 Remote sample 的 Historical revisit 区分；当前任务、最近任务及失败统计共用有限词表，未知任务保持 Unclassified task。worker 历史、稳定性和运行统计均拒绝不存在的日历日期，不把归一化后的错误日期当作成功时间。Remote sample 的 local versions behind 表示本地版本落后；prior findings 排除本轮列出的差异，仍可能包含本轮已回访但未解决的目标，详情明确说明该口径。

显式 `status --logs` 的私有日志尾部允许普通文本、非对象 JSON 和损坏事件。只有字段形状可识别的事件才压缩成摘要；其他行原样交给既有终端净化和折行层，不得使已经收集的状态整屏失败。无效布尔结果不能被解释为成功或失败。日志文件、JSON 输出和公共状态证据不变。
