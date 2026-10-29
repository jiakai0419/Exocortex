# 图片资源补齐

`maintenance enrich --target resources` 仍是一次显式、精确记录维护操作。
现有 worker 的共享空闲预算另可调用 `maintenance resources`，通过持久队列补齐已知图片，
复用同一资源采集实现；其准入、失败隔离和恢复边界见[资源任务](resource-work.md)。
普通消息读取不触发资源下载。
它只处理调用方选定的 1–20 个不重复的正整数 `--record-id`，不扫描其他记录，也不接受
`--limit`、姓名、发送者、应用探测、unsafe 明细或 review 参数。除公共 `--db` 和
`--format` 外，可用参数为 `--record-id`、`--apply`、`--max-cli-attempts`、
`--max-seconds` 和 `--resource-dir`。

默认预览只读取本地记录和资源证据，不联网、不创建请求会话、不下载、不写 SQLite
或资源文件。`--apply` 才允许在现有账号权限内读取精确消息资源并发布本地私有侧车；
它不修改 SQLite、消息正文、身份、来源时间或顺序，也不修改账号和权限。

```sh
# 以下路径和记录号均为合成示例。
node bin/exocortex.mjs maintenance enrich --target resources \
  --db /tmp/exo-synthetic/messages.sqlite --record-id 1 --record-id 2
node bin/exocortex.mjs maintenance enrich --target resources \
  --db /tmp/exo-synthetic/messages.sqlite --record-id 1 --record-id 2 \
  --max-cli-attempts 12 --max-seconds 30 --apply
node bin/exocortex.mjs messages --db /tmp/exo-synthetic/messages.sqlite \
  --resource-dir /tmp/exo-synthetic/messages.sqlite.resources --format json
```

资源目录默认是已解析数据库路径加 `.resources`；显式 `--resource-dir` 相对调用 cwd
解析。补抓和 `messages` 必须使用同一目录。`messages` 仍是本地只读操作，不因目录
不存在、资源失效或缺失而自动下载。目录与文件权限、字节验证、消息版本及账号绑定
见 [本地图片资源证据](media-resource-store.md)。文件路径只属于私有消息输出；可用
资源不意味着生成了 OCR、图片描述、语音转录或额外正文。

整条命令默认最多 12 次 CLI 进程尝试、30 秒远端工作，参数范围分别为 1–1000、
1–180。身份检查和下载共用预算；次数不是 HTTP 请求总数。资源路径使用原生
`api GET /open-apis/im/v1/messages/<message-id>/resources/<key>`、用户身份和二进制
`--output`，不使用会对流式错误自动重试的资源快捷命令。收到拒权或安全策略错误
即保留原因并停止，不重试拒权、不切换身份、不扩权。
拒权只归于实际失败的下载项；未请求项为 `batch_stopped`，已下载但未通过最终
账号/来源围栏的项为 `publication_not_attempted`，不能把整批都算作接口拒权。
单图格式不支持或图像字节无效按项保留失败，并在原预算内继续其他独立选中图片；
路径、文件权限、链接、响应、账号或数据库身份安全契约失效仍整批停止。单条消息
来源版本漂移按原逐行围栏阻止该行，其他独立且围栏通过的图片仍可发布。

请求前后须验证账号，并在发布前复核来源记录围栏；版本、内容 hash、消息、会话或资源 key 有漂移时
不得发布可用证据。下载成功和非空文件本身都不构成可用；须通过侧车的绑定与图片
字节验证。PNG/GIF 使用严格像素流验证，JPEG 使用[严格原生验证器](strict-jpeg-resource-validation.md)；WebP 仍为本地验证格式不支持，
不是请求成功即完成。贴纸保留忠实类型及官方资源接口不支持的明确状态，
不发试探下载请求，不把未知或缺失资源标为 ready。

CLI 1.0.56 的资源元数据和官方边界见
[消息资源接口](https://open.feishu.cn/document/server-docs/im-v1/message/get-2?lang=zh-CN)、
[通用 API 文件响应](https://github.com/larksuite/cli/blob/v1.0.56/internal/client/response.go)
和 [快捷下载重试](https://github.com/larksuite/cli/blob/v1.0.56/shortcuts/im/im_messages_resources_download.go)。
这些描述证明接口能力，不证明某账号或某条消息已经具备读取权限。
