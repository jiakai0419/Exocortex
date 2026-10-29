# 图片与贴纸资源引用的只读展示

本文约定原生媒体引用的只读投影；它本身不下载资源、不生成 OCR 或语音正文。
图片获取与私有文件验证见 [获取契约](media-resource-acquisition.md) 和
[存储契约](media-resource-store.md)。原始消息、存储正文、canonical、来源时间、
排序及基于已存正文的搜索保持不变。

## 可读与完整契约

仅支持明确原生 `image` 和 `sticker` 类型，分别检查 `body.content` 中的
`image_key` 和 `file_key`。来源引用只是 API 标识，不是 URL、文件路径、
已下载文件或可用图片。即使字段非空，也不能把内容要求记为 satisfied。
未知消息类型、未知富文本节点与卡片继续使用原合同，不借本改动变成 ready。

当前 raw 的只读投影添加可选 `display.media`，版本 1：

- `type`：`image` / `sticker`；`text` 是忠实类型及资源证据说明。
- `status: partial`；`reason` 为 `media_resource_unavailable`、
  `media_reference_missing` 或 `media_reference_invalid`；有效贴纸引用明确为
  `media_resource_unsupported`，不试探官方不支持的下载接口。
- `resource` 包含 `kind: image_key|file_key`、`key: string|null`、
  `state: reference_only|missing_reference|invalid_reference`、
  `availability: unverified`（贴纸为 `unsupported`）。`reference_only` 不证明
  远端拒权、失效或可下载。图片经过独立本地文件验证后才允许 `status: rendered`、
  `reason: null` 和 `resource.state/availability: available`，并包含 path、
  size_bytes、mime_type、sha256、binding_digest、observed_at。目前仅 PNG/GIF 可用；
  JPEG/WebP 即使已有缓存也不能凭容错解码而变为 ready，有限验证原因为
  resource_format_unsupported。失效缓存为
  `media_resource_invalid`，不会沿用旧 ready。
- 原生数据无效、重复 JSON 键、超出解析边界、空/类型错误的引用均不能形成
  有效资源引用；未知字段仍留在 raw，不猜测它是正文或资源证据。

原始/规范 JSON 与内容 JSON 字符串输入上限 256 Ki UTF-16 单元；来源超限时
只给无效引用诊断，不解析或采用 key。重复来源 JSON 无新媒体投影，仍按既有
完整性规则拒绝。直接对象只检查登记字段；资源引用
上限 2048 UTF-16 单元，不接受空白、控制字符或 URL/路径作为标识。正文与 raw
仍保持原样，超限或非法字段不通过截断转成有效引用。不执行任何引用。

原生明确类型、消息 ID 和会话 ID 必须与当前行一致。类型冲突、损坏包装
不能从 canonical 猜类型或借旧摘要构造有效引用。撤回记录沿用 tombstone
合同，不新增媒体展示。旧 `content_rendering` 的 unsupported 诊断可以被
当前媒体投影细分；只有额外的资源验证证据才可以升级图片完整性。

只有引用的内容要求仍为 blocked：有效图片引用但无可用资源证据对应
`content_resource_unavailable`；贴纸接口能力限制为 `content_resource_unsupported`；
本地资源验证失败为 `content_resource_invalid`；缺失/无效引用对应 `content_reference_missing` /
`content_reference_invalid`。下一步为 `review_content`，不暗示后台已排队下载。
这些新 finite reason 与原有 `readiness.version=1`、四种互斥状态兼容，消费者须
容忍新增 reason。质量统计、JSON 与终端共用同一判断；增加类型诊断本身不会
提高完整数，验证成功的图片可以满足内容要求。

非 ready 的媒体异常行保留原位置、头部、状态及所有原因，并补充类型与
资源说明；终端不输出资源 key，也不编造图像描述、OCR 或语音正文。已有
ready 文本布局、display.body 和未知内容异常布局不变。可用图片展示真实本地
路径、格式与字节数；不把存储的旧 fallback 当作图像描述。

## 验证边界

全部提交的输入从零合成，覆盖图片/贴纸、未封装/原生封装、缺 key、类型错误、
重复 JSON 字段、超限、消息/会话/类型冲突、撤回、伪造下载 URL、相邻文本与未知
类型。真实 CLI JSON/文本验证顺序、limit、方向、搜索、身份/正文/来源时间与
原始 JSON 不变，读取不联网也不写库。真实本地核对只保存在仓库外的私有目录。

本补齐明确区分“不认识类型”和“已认识资源引用但内容未取得”。取得真实资源
按独立获取契约完成来源账号、消息版本、资源绑定和文件验证后才可使用；
贴纸仍受官方接口能力限制。单个消息是否可用须以其实际资源验证结果为准。
