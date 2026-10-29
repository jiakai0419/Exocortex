# 本地图片资源证据

本模块只管理已由调用方取得的图片字节，不联网、改账号、查询消息或写数据库。
下载成功、非空文件、扩展名和来源 key 都不能单独证明资源可用。

## 绑定与接口

`resourceStorePath(db, override?)` 默认返回 `resolve(db) + '.resources'`。
`makeMediaResourceBinding(db,row,accountKey,media)` 只接受 lark.im 的 image 消息，
资源投影必须有合法 image_key。绑定包括数据库真实路径和 dev/ino（不以数据库
大小、mtime、ctime 作为版本）、source_id、external_id、external_version（可 null）、
content_hash、container_id、account_key、image 类型及 key。消息原始 JSON 的 SHA256
必须等于 content_hash，原始类型/消息/会话/key 必须精确一致。绑定失败返回 null。

`assessMediaImageBytes(bytes)` 返回 `{image:{mime_type,width,height}}` 或有限 `{reason}`，
便于调用方区别损坏、缺解码器和不支持格式。`inspectMediaImageBytes(bytes)` 保留 image/null 简化接口。

`publishMediaResource(cacheDir,binding,bytes,{nowMs})` 验证字节并发布资源；
`readMediaResource(cacheDir,binding)` 每次重新核验绑定、文件和字节。这里的只读表示
不修改数据库、缓存和原始证据，也不创建临时解码文件或启动外部解码器。成功返回
`{status:'available',path,sha256,size_bytes,mime_type,binding_digest,observed_at}`；失败只返回
有限 `status/reason`，不带异常、SQL、来源标识或私人路径。path 只出现在可用的私有
资源结果中，不是远端 URL，也不触发打开、执行、OCR 或图像描述。

manifest 用规范字段顺序的绑定 JSON SHA256 寻址；它只能指向同目录中由图片
SHA256 推导的 blob 名，不能提供任意文件路径。数据库文件被替换、账号/消息版本/
来源 hash/key 改变均不能借旧 manifest 建立可用状态。绑定不可作为作者身份来源。

## 文件与字节边界

缓存目录必须由当前用户拥有、无组/其他用户权限、不是符号链接。新建目录 0700，
文件 0600。读取通过 O_NOFOLLOW/O_NONBLOCK 和文件描述符进行；拒绝硬链接、FIFO、
非普通文件、超限、权限不符及读取前后 inode/size/mtime/ctime 等变化。目录与数据库
身份也要复核。manifest 与 blob 均先写独占临时文件，再以不覆盖现有文件的原子
链接发布，已存在的有效证据不会被后来的竞争发布覆写。失败可遗留无 manifest
的内容寻址 blob；它不能使任何消息成为可用。

单图最多 16 MiB。格式签名和 chunk 名按原字节核验，不能通过丢弃高位的 ASCII
转换把非法字节认作合法标记。PNG 核对完整 chunk 长度、CRC、IHDR/IDAT/IEND 顺序以及有界
zlib 解压后的扫描行长度/过滤类型；索引色 PNG 在反滤波后逐像素核对色板索引；
GIF 核对块边界、LZW 码流、像素数量、颜色表和完整 trailer。
JPEG 和 WebP 目前只核对容器基本结构，不建立可用资源证据：结构合法时明确返回
`invalid/resource_format_unsupported`，损坏容器仍返回图片验证失败。macOS `sips`
对缺少 JPEG MCU 编码或缺失 WebP 压缩数据的合成输入可以补像素并成功退出；
输出 PNG 尺寸正确也不能证明源像素流完整，因此不再使用它作发布/读取证明。
在严格解码器或完整码流验证到位前，即使某张 JPEG 能被客户端打开，也不会标为
available；这是本地格式验证能力限制，不是上游拒权、永久不可见或内容已恢复。
此限制同样适用于旧缓存中的 JPEG/WebP，后续读取必须降回明确不支持。
不通过扩展名、非空字节、头尾标记或系统解码成功绕过该边界。
PNG/GIF 验证仍在内存内执行，继续拒绝 HTML/JSON、只有魔数、截断文件和超预算
像素流。没有 OCR、图片描述、客户端启动或隐式网络请求。
有效 PNG/GIF 的完整像素流验证不证明任何 OCR、语义或所有客户端的显示完全相同。

缓存证据是本机可信下载路径产生的材料，不是防当前用户任意伪造文件的密码学签名。
字节变化、非规范 manifest 字段或绑定不一致均拒绝；同一来源的原始消息正文、
身份、时间、排序及数据库内容不变。调用方负责在远端请求前后验证账号、对下载
请求作精确消息/资源绑定，并在发布前重新确认原记录没有变化。

## 验证

所有测试从零生成临时数据库占位文件和图片字节，不读取真实聊天、数据库、账号
或资源。覆盖跨账号/消息/数据库/版本、修改字节、缺文件、恶意 manifest、路径与
链接、文件权限、图片截断/大小上限、竞争发布、失败后无可用 manifest及只读不变性。
