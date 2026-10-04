# 卡片与身份投影设计

本设计约束本轮 Node 卡片阅读与姓名补全的共同机制。先按这里的证据、语义和边界实施，再用合成组合用例验收；不按截图、应用名称或正文关键词选择模板，不重构全项目。卡片展示版本为 3。下表记录模块职责与本轮实现；设计和本地测试不表示生产验收已完成。

## 数据职责与兼容

| 层 | 责任 | 不承担的责任 |
| --- | --- | --- |
| `raw` | 保存消息 API 的原始证据，包括外层包装、卡片节点、mentions、附件映射及按钮数据 | 不用姓名补全或显示结果改写原文 |
| `canonical` / 存储 `body` | 可重建的入库投影、姓名来源与状态、历史渲染版本；按既有源版本和事务规则更新 | 不把解析成功解释为原始数据最新 |
| `display` | 卡片从本条 raw 构造；sender/chat 等既有展示可用其本地姓名投影，但不供卡片猜名 | 不联网、不执行动作、不隐式回写历史记录 |

保留现有 JSON 字段与含义，尤其 `body`、`raw`、`canonical`、原始 JSON 字符串及 `display.body`。卡片由 `display.card = {text,status,reason,version}` 表达；可选的 `omitted_actions` 计数也随新入库 `content_rendering` 保留；该计数与纯动作的中性收起说明仅表示有意省略，不表示任务或审批状态；历史阅读使用当前解析器，但不修改 raw/hash/source version/canonical。更新历史 sender 姓名必须经显式、有界补全，不能让 `messages` 在阅读时联网。搜索仍匹配已存 body，不因读取时重投影改变索引语义。

## 身份与姓名证据

统一规则是先确认身份命名空间，再取姓名；共同规则不要求把纯本地卡片解析和可联网 sender resolver 合成一个服务。

- 身份按 `(namespace, value)` 比较，并受账号/应用边界约束；群成员名字还受会话范围约束。`open_id`、`user_id`、`union_id`、`app_id`、消息内 `mention_key` 与卡片 `nativeRef` 相互独立。open-ID 查询通道仅接受明确的 open-ID 证据及 `ou_` 形式，不能把任意 `user_id` 或别的命名空间中的同字符串当作 open ID。
- sender 使用原始显式 `id_type` / typed ID 字段确认身份；原始 sender 姓名、已验证自身身份、对应联系人或会话成员响应才可提供该身份的姓名。app 保留既有独立来源与置信度，不混入用户姓名通道。身份或会话范围变更时不继承旧姓名。
- 卡片只使用本条 raw：`mentions.key` 是消息内别名；`{id,id_type}` 或 `id.open_id/user_id/union_id` 提供 typed 身份，裸 `id` 不自动注册到其他命名空间。`body.content` 包装中的 `json_attachment.at_users` 提供显式桥：`nativeRef` 精确匹配 `at_users` 的自有字典键或条目的 `user_id`，经 `mention_key` 连接本条 `mentions.key` 取姓名。附件里的 `user_id` 在这里是原生引用桥字段，不能顺带注册成全局用户 ID；`attachment.content` 不作为姓名证据。
- 相同文字、出现位置、列表顺序、前缀相似、姓名相似都不是身份映射。只有同条消息内明确无歧义的桥允许跨命名空间连接；无桥、断桥、多目标或冲突都保持未知；重复 key 含缺名、不同身份即使同名、别名指向不同 binding，均不能靠顺序选一个。身份一致性逐命名空间核对：已有共享且一致的 typed 身份或同一明确证据桥时，增补不冲突的 typed ID 不应仅因整组字段不同被当成换人；只有互不相交的 IDs 时，即使姓名或 mention key 相同也不能据此合并身份。卡片不得为此引入 API、其他消息或持久姓名缓存。

卡片引用的消费空间固定如下，禁止先把全部键塞进一张无类型 Map：

| 引用形式 | 唯一允许的解析空间 |
| --- | --- |
| `@_user_…` token | 仅本条 `mentions.key` |
| 明确 typed 字段或 `{id,id_type}` | 仅所声明的 namespace，不能借同字符串访问其他空间 |
| 原生 `at.userID`、`<at id>` | `nativeRef`，先走显式附件桥；有附件但无可用桥时保持未知 |
| 旧格式无附件的裸 literal | 只作 exact alias 兼容，且必须唯一对应一个身份与命名空间；碰到多 namespace 或冲突即未知，不靠 `ou_` 前缀挑一个 |

sender 的兼容输入范围是有限的：接受 `sender.id` 配合显式 `id_type`、直接 `open_id/user_id/union_id/app_id`、`sender.sender_id` 对象里的同名 typed 槽，以及旧字符串 `sender_id`。actor 始终是非空字符串或缺失，按 `id → open_id → sender_id.open_id → sender_id.user_id → sender_id.union_id → 字符串 sender_id → user_id → union_id → app_id → sender_id.app_id` 的固定顺序选择；选择与声明的 namespace 必须一致。这个顺序保留原先有效字符串槽的优先级，SQL 与 JS 用组合测试校验一致。对象、数组或其他非字符串 typed 值，以及没有任何支持的 typed ID 的 `sender_id` 对象，均为不可信身份，不能直接供名或联网。IDless 消息仍可保留自身明确姓名，但没有可继承或查询的身份；无类型或未知类型的标量 ID 不授权 open-ID 查询。这是本地兼容输入合同，不表示每个形状都已在当前远端 API 观测到。

所有明确 ID 槽构成同一条源消息的 alias 集合。直接姓名、远端候选与已存姓名若等于其中任何 ID，均为 unknown；原消息明确给出的 alias 即使未出现在远端响应中也有效。先做这项校验，再决定是否查询成员 fallback，不能用回显值计为 resolved 或抑制补全。共享正向缓存也不能把本次已知的 ID 回显当作成功；真实姓名、显式 clear 和同版本改进的既有规则保持。历史 sender-only 仍只修可信匹配的 open-ID 姓名，不隐式迁移错误 actor 或增加 user/union-ID 远端查询通道。

继承旧姓名需要同时通过旧、新来源的可信 alias 校验。相同 actor、namespace、chat 只说明身份可比较，不足以证明旧值仍是姓名：较新来源可能新增一个 typed ID，揭示旧值其实是 ID 回显。此时不得在新投影已经判定 unknown 后恢复旧值；这不是权威清空，也不产生 clear 标记。无关的新 alias 不影响真实姓名继承，显式 clear、新可信姓名及源版本保护保持原规则。跨版本写入保存被接受的新 raw/hash/version；旧版本重放不能逆转它。

sender 持久投影新增 `canonical.sender_id_type`。姓名 SQL 合并只有 effective namespace、actor 与适用的 chat 均相同才可继承。旧 canonical 缺 type 时先核对 raw 的显式类型；raw/canonical 相互矛盾不得继承。仅当两者都无类型证据时，`ou_` 兼容解释为 `open_id`、`cli_` 为 `app_id`，其他为 opaque legacy；显式 `user_id`/`union_id` 不能与这些旧兼容类型相等。该旧记录规则只服务合并兼容，不能授权联网；网络查询仍要求原始显式 typed 证据。新增类型须与 `message-record`、resolver 和补全共用同一小型身份函数，不让每条路径自行猜测。

姓名状态沿用已实现的 SQL 合并合同：`resolved` 保留姓名与来源；缺字段、空 lookup、超时、拒绝、冲突为 `unknown`，不能抹掉同身份已有值；只有显式 `*_name_state=cleared`（对方为 `chat_partner.name_state`）才是权威清空。未知不能复活已清空值，新可信解析可以更新它。缓存会话名等历史证据只能补未知，不覆盖已知或权威清空。原始消息中的新姓名及同版本投影改善仍按既有版本保护规则处理。卡片临时映射只决定本次展示，不产生权威清空或修改 sender 的存储姓名。

联网 resolver 保持 best-effort：消息采集不依赖姓名查询成功。正向缓存只保存确实解析出的姓名，键保留类型及必要的会话范围；ID 回显、空响应、错误和权限失败不缓存。现有容量为 1000、TTL 为 5 分钟，读取只刷新 LRU，不延长 TTL；每次查询已有 5 秒重试预算。过期或失败后仍可重新查询；实例不能跨账号复用。响应只接受本次明确请求的 typed ID，未请求的返回项不进入上下文。5 秒是单次调用预算，群成员最多 50 页也不等于一次补全有总预算。联系人批次固定 30 且显式 page-size=30；响应姓名、成员 localized_name、请求目标筛选和 self seed 优先级只在共享 resolver/身份 helper 维护，在线同步与常规/单目标 enrich 都委托这些规则，脚本只保留诊断与提交职责。

历史补全采用明确的 sender-only 路径：必须同时指定 `--sender-only --sender-id <open_id>`，只选择一个 actor，不增加 record/scope 泛化选择。`--limit` 默认 50、最大 100；SQL 先按目标身份及缺名或 ID 占位筛选，再按 `occurred_at_ms ASC, id ASC` 截定候选。排除已知姓名、权威 clear、无 actor、app 及 typed 冲突；先验证 row/canonical/raw 的可信 sender 身份一致，零候选零网络，不查询 self 或额外 profile。

查询复用 resolver/transport，保留 30-ID 联系人批次但本模式唯一用户目标为 1；整轮远端预算 30 秒，每请求 timeout/retryBudget 不超过剩余预算与 5 秒的较小值，`retries=0`。群成员 fallback 整轮最多 3 个候选 chat、5 页（每页 100）；限额、截止或仍有 `has_more` 时明确 unresolved。contact 名只能用于同账号目标 actor 的选中记录，member 名只用于对应 chat。网络在维护锁外；短事务按原快照 CAS 并使用共享 merge，仅补充必要的 canonical.sender_id_type 身份元数据，并更新 sender_name/source/confidence 与 updated_at，保留 raw/hash/version/body/chat/partner 等其他字段。`first_seen_scope_id` 不能充当完整会话归属。`maintenance enrich --target records` 默认预览，仍可读取远端；`--apply` 才提交，不是离线模式。以上选择与数量参数已由集成任务确认冻结，不得按一次样本临时放宽。

联系人、群成员、应用名和机器人回退四类查询与匹配规则仅在 `name-resolver.mjs` 实现。常规同步及 record enrich 调用相同规则；脚本只将私有 `onLookup` 事件映射到既有计数和显式 `--unsafe-details` 字段，回调失败不改变姓名结果。`--probe-apps` 使用明确的 `forceRefresh` 绕过并驱逐应用正向缓存；强制查询失败保持 unknown，允许下次重试，绝不制造 clear。默认五分钟 TTL、1000 项容量及 positive-only 缓存规则保持。

两种补全都使用共享 transport。姓名与单个会话元数据查询使用同一个五秒请求预算常量，补全不自动重试；sender-only 仍额外限制整轮预算和扫描范围。scope enrich 通过 adapter 的单会话元数据读取复用响应校验和名称提取，保留原有 20MiB 子进程输出上限及独立的 scope 快照比较事务；record enrich 保留默认 50MiB 上限。私有详情继续包含明确请求的 ID、解析名称和诊断字段，失败 message 使用共享的安全描述；默认输出不透传远端 stderr。

## 正文、动作与诊断

按节点语义遍历，而不是把所有子节点拼成一串：块级标题、段落、独立容器和字段保留边界；字段标签与值保持关联。容器的 text、fields、elements、actions、columns、extra 是不同内容槽，切换到实际输出内容的槽时保留块边界；空数组或全部收起的动作不凭空增加换行，显式 br 仍保留；同一 elements 槽里的行内文字、提及与链接连续输出，前后及尾部有语义的文本不能丢。`br` 节点换行，不承诺把任意文本里的 `<br>` 当作 HTML。语言选择沿用明确优先级，不拼接多种语言副本。

文本槽依次选择 `i18nElements → i18nContent → content → text → elements`，同一槽中的语言依次选择 `zh_cn → en_us → ja_jp`。缺失的语言槽或经检查确认为空字典的语言映射不提供语言投影，继续下一个槽；因此空映射不能遮住已有默认标题、字段或正文。仅检查是否为空，不遍历未知语言正文或执行访问器；该规则适用于现有共享解析器，不新增按卡片来源选择的旁路。

| 语言槽证据 | 回退与诊断 |
| --- | --- |
| 槽缺失，或外层语言映射为 `{}` | 继续下一文本槽，不单独产生 partial |
| 存在受支持语言的有效字符串、数组或对象 | 只消费选中的语言值，不拼接较低优先级语言或默认文本 |
| 已选语言明确为 `""` 或 `[]` | 保留明确空值，不借默认正文填充；全卡没有可见内容时仍沿用既有无正文诊断 |
| 已选语言为 `{}` | 按既有节点规则诊断，不把语言值误当作缺失的外层映射 |
| 外层槽为 `""`、`null`、数组等损坏类型，或非空映射只有未知语言 | 保留 unsupported 诊断，不用默认文本隐藏问题 |
| 高优先级语言值无效而后续受支持语言有效 | 沿用已有可读替代语言与 partial 诊断，不抹除损坏证据 |

默认 `content/text/elements` 的已有优先级和显式空值语义不变。回退后暴露的未知提及、非法链接、未知正文或资源超限仍须报告；恢复默认文本不等于整张卡必然 rendered。纯请求按钮的收起策略、raw 事实及只读展示无网络/无回写的边界不变。

信息保留按源证据逐项验收，不能以行数、JSON/文本一致或 `rendered` 状态替代内容核对：

| 信息 | 有证据时的展示要求 | 无证据时的边界 |
| --- | --- | --- |
| 标题与结果 | 保留所选可见标题、源正文明确表达的结果及其对象；空语言映射不得遮蔽默认值 | 客户端显示已改变但已存快照未包含的结果，不能由按钮、颜色或应用名称推断 |
| 人名与对象 | 原文普通文本保持；提及按本条消息的明确身份/附件桥解析，保留出现位置和相邻正文 | 没有可信映射时保留未知占位，不能用发送者名或其他消息猜测 |
| 关键字段 | 保留标签、值、顺序和行边界，嵌套已支持布局与 property 包装使用同一规则 | 源里本来为空的字段不能填造；未知结构仍报告缺失 |
| 正文结构 | 保留行内拼接、段落、字段及有意义的尾部，回退后继续既有节点遍历 | 不将 arbitrary callback/value/config 当正文，不拼接多语言副本 |
| 链接 | 保留可见标签及安全导航目标，敏感 URL 部分按既有规则省略 | 请求 payload 中的地址不自动成为导航；非法目标不能静默消失 |
| 动作与远端状态 | 有意省略纯请求操作时保留中性说明/计数及完整 raw | 操作定义不是执行结果；本地投影成功不证明快照等于当前客户端状态 |

若截图与已存原始快照的状态不同，分别记录“源里已有但显示丢失”和“该快照未提供”的信息。前者通过解析修复恢复，后者不能靠展示补造；尚未核实当前远端读取结果时，不得宣称 API 永远不提供该状态。本规则不引入后台状态轮询、历史记录隐式刷新或新写入路径。

| 分类 | 展示规则 |
| --- | --- |
| 正文 | 只读已支持的可见 text/layout/field 槽；未知可见正文或有意义的尾部未能读取，必须报告缺失 |
| 导航 | 已知 link/button 中的安全 HTTP(S) 地址可以展示；支持明确的 `link.url = {url:string}` 包装和既有 `multi_url` 平台槽；`button.actions` 只接受已知 `type=open_url` 的明确 URL 字段，`action_request`、value/callback 内的链接不是导航证据 |
| 动作 | 只正向识别已知 request/action_request 动作，或无 navigation 且无 actions 的简单 button，确认没有可用导航链接才收起；不执行 callback/value，不把“收起”解释为完成或同意，完整数据仍在 raw。已确认纯动作被有意收起可以保持 rendered；未知 action type、未确认分类或检查超限仍为关键 partial，不默认为纯动作 |
| 装饰 | 只有已知且不携带正文语义的装饰才可省略；不能按未知 tag、颜色或位置猜它是装饰 |
| 未知 | 默认视为可能缺少正文，保留 partial 诊断；非空无效 URL 不得通过“无链接动作”分类被静默隐藏 |

导航的 `url`、`href` 是有顺序的显式目标槽。先按既有资源预算解开支持的 `{url: …}` 包装，再统一判断 `undefined`、`null`、空串为无目标，允许选择后续槽。非空但非法、类型不支持或资源超限的首选目标仍保留诊断，不能以回退成功掩盖损坏的证据；callback/value 仍不提供导航目标。按钮是否收起在这一统一选择和安全校验之后判定。

未知身份在提及原位置显示占位。若唯一问题是未知提及，`status=partial`、`reason=unresolved_card_mention` 仍保留，文本不再重复通用整行说明。内部应保留全部问题类别后再决定摘要：未知提及与无效链接、未知正文或超限并存时，后者不能被占位或折叠动作掩盖。现有单个 `reason` 字段保持兼容；采用确定的摘要优先级：存在非 mention 问题时优先选它并展示说明，例如未知提及与非法 button URL 并存不能只返回 mention reason；必要的人类缺失说明必须覆盖仍存在的关键问题，不能从“只返回一个 reason”推导“只有一个问题”。

## 资源、隐私与远端状态

累计解析字符串和待检查文本分别限制为 256 Ki UTF-16 单元，姓名来源计入文本预算；深度 24、节点访问 2048、输出含说明 16,000。附件映射、多层 wrapper 及新节点共享这些预算，不能各自重置。新别名/身份复合键必须先验证、计入输入预算，再拼接或序列化，不能先分配巨大字符串再扣预算；不能在解析前无界复制、展开或截断后重新解释。姓名生成结果作为终态文本缓存，不递归展开或重新送回父文本扫描器。

继续按原始源码位置先消费完整 URL、Markdown 目标和 OSC/控制区间，再解析 URL 外的提及。HTTP(S) 仅显示 origin/path，明确省略凭证、查询及 fragment；生成姓名与链接标记不能改变原始 URL 边界。隐藏控制区间不可被提及或换行拆开；有界、单向扫描及现有外部进程 deadline/内存反证不得削弱。公开诊断只给计数、类别与检查结果，不记录真实 ID、姓名、正文、完整链接或私人路径。所有新 fixtures 从零合成，不复制或脱敏生产输入。

采集的是 API 快照。正常列表游标按 `create_time` 前进，旧卡片的 `update_time` 变化不自动重新入窗；普通卡片不属于合并转发 details 队列。一次同身份单条 GET/mget 的有限核查可比较原文与源版本，但 API 快照不保证包含客户端当前交互状态。无证据不能推断“已处理”或“解析遗漏”。本轮不引入状态轮询；现有 bounded replay 取 received list 且要求严格更高数字版本，同版本冲突或 GET/list 差异不能靠回退游标解决。

## 模块职责与本轮实现

| 模块 | 已有责任 | 本轮实现 |
| --- | --- | --- |
| `src/adapters/lark-im/card-content.mjs` | 有界卡片遍历、URL/控制序列安全、纯本地 mentions、诊断 | typed 身份表与附件精确桥；块/行内/字段语义；动作/装饰/未知分类；v3 及多问题摘要 |
| `src/adapters/lark-im/name-resolver.mjs` | 联系人/成员/app 查询、正向 LRU/TTL 与查询预算 | 内部 open-ID map 仅接收共享身份校验后的明确目标，实例不跨账号；移除 ID 当姓名的 fallback，拒绝未请求回包项；失败继续成员 fallback/可重试 |
| `src/adapters/lark-im/message-record.mjs` | sender 身份、姓名来源、raw/hash 与入库投影 | 持久化 sender_id_type，与上述命名空间规则及共享身份函数对齐；不改 raw 语义 |
| `src/storage/sqlite/lark-name-projection.ts`、`ingestion-store.ts` | 同步/补全共用姓名合并、版本与事务/快照保护 | 补 namespace+actor+chat 继承门槛与旧类型兼容；复用 unknown/clear/同版本改善，不另建卡片姓名写入规则 |
| `src/diagnostics/messages-report.mjs`、`src/terminal/messages-view.mjs` | 只读历史展示及 JSON/文本出口 | 同解析器、无网络/回写；行边界与 partial 说明在最终 CLI 保持一致 |
| `src/maintenance/enrich-records.mjs` | 显式历史补全、共享 SQL merge、维护锁与并发比较 | 联系人与成员请求委托共享 resolver，常规路径保留 recent 扫描和诊断；新增精确有界 sender-only，先按缺名/身份筛选再 LIMIT，统一预览、CAS 与失败语义；不将常规 --limit 冒充定位/总预算 |

优先在这些现有职责内加入小型纯函数或共享规则，不新增模板调度、全局身份服务或解析框架。实现依照先定设计与合成反例的顺序；生产 worker、数据、部署和 push 均不属于本轮实施范围。

## 可测试不变量与组合矩阵

必须保持：① 改变来源顺序不改变身份结果，跨命名空间碰撞不串名；② 明确桥成功、缺失/冲突为未知且无新网络；③ unknown 不抹已知或复活 clear，身份变化不继承；④ 失败不负缓存、TTL 到期可刷新、缓存有界；⑤ 块可分、行内可连、字段及尾部不丢；⑥ 收起动作不隐藏正文或关键诊断，未知提及不掩盖其他问题；⑦ 新旧记录使用同一投影，历史 CLI 无写入且 JSON/raw/hash/version 兼容；⑧ 所有新组合服从现有资源、URL 和控制区间上限。

语言回退另以从零合成输入覆盖缺失、空映射、外层空字符串、所选语言显式空字符串/数组/对象、有效语言及槽/语言优先级；组合标题、字段、行内正文、导航与收起动作。保留未知语言、损坏值、访问器和资源边界的反证，并经真实 `messages` JSON/文本出口验证默认静态内容恢复与原始 SQLite 记录不变；不得以真实卡片或其脱敏副本作为 fixture。

下列是组合场景，不是模板类型；同一结构更换标题、应用或业务词不应改变解析路径。

| 合成场景 | 必须交叉覆盖的机制 |
| --- | --- |
| 文档权限 | 附件引用桥 + 多人 mentions + 无链接动作/安全导航并存 + API 快照缺少客户端状态 |
| 人事提醒 | typed user/union/open-ID 同字符串冲突 + br/字段/尾部正文 + 缺桥与未知提及 |
| 审批 | 多个动作 + 导航包装/非法平台地址 + 块/行内组合 + 未知提及同时出现未知正文 |
| 资产 | 装饰与可能承载数据的未知节点并存 + 嵌套布局 + URL 中提及形状与控制序列 |
| 普通富文本 sender | 原始 sender/联系人/群成员来源 + 已知→失败→恢复、clear→unknown、改名/换身份、TTL/容量及历史有界补全 |

每行至少覆盖完整、缺失、冲突与超限变体，并组合嵌套 wrapper、重复映射、乱序及原始输入不变性。保留现有强度的 URL/OSC/提及资源反例；新增单元测试和实际 `messages`/临时 SQLite 集成测试，不能只测 helper 或字符串快照。最终由集成任务记录 focused、build/typecheck/syntax/full tests 与 generated-file 检查的通过、失败、未跑状态；设计或过往测试通过不能替代本轮验收。
