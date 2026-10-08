# 后台服务依赖契约

`service install` 将当前运行 Exocortex 的 Node 可执行文件和所选 `lark-cli` 保存为绝对路径。`LARK_CLI` 可指定绝对路径或当前命令环境能找到的可执行文件；未设置时按当前 `PATH` 选择 `lark-cli`。SQLite CLI 和 Python 则分别按安装命令的 `PATH` 选择 `sqlite3`、`python3`。相对路径会按安装命令的工作目录解析，安装后不依赖该工作目录。

后台 `PATH` 只包含所选 Node、SQLite、Python、LARK CLI 的目录和固定系统工具目录，不复制完整 shell 环境或令牌。安装检查此最终 `PATH` 下的 `node`、`sqlite3`、`python3` 是否仍指向同一可执行文件；符号链接可指向同一文件。目录之间存在同名命令冲突、或自定义 Node 文件名不能由 `node` 找到时，安装失败，不静默切换依赖。请使用互不冲突的依赖目录后重新安装。依赖升级或移动后也应重新安装；本检查不锁定文件内容，不承诺安装后的文件不会变化。

任何配置写入之前，安装以所选后台 PATH、隔离初始化环境进行本地能力检查。已安装配置完全相同且依赖选择未变时返回 `unchanged`，不重复运行能力探针；该结果只表示无需改写配置，不是运行健康证明。写入前的检查要求：

- Node.js 22 或更新版本；
- SQLite CLI 3.35+，支持 JSON 输出/函数、MATERIALIZED、RETURNING 和 `-readonly`；
- Python 3.9+，具备 `fcntl.flock`、非阻塞文件描述符和 SQLite JSON/schema 查询能力。

检查仅使用内存库和进程管道，不读取运行数据库、不访问网络、不启动 worker、不执行 `lark-cli`（包括版本查询）。检查只传递所选 `PATH`、`LARK_CLI`；Node 不继承调用者的初始化变量，Python 使用 `-I -S`，SQLite 使用 `-init /dev/null`。失败只报告依赖和要求，不输出探针 stdout/stderr、环境值或私有路径；原有 plist 保持不变。

LaunchAgent 的 `EnvironmentVariables` 追加或覆盖指定变量，并不清空 launchd 域的其他环境。此检查不验证继承值（例如 `NODE_OPTIONS`）、Python site 或 SQLite 初始化配置，也不改变实际 worker 的初始化方式。探针通过只证明这些可执行文件在所选 PATH 和隔离初始化条件下具备所需能力；真实后台仍按 Operations 验收，不能把探针成功当作完整启动环境或账号已通过验证。

`lark-cli` 只校验为可执行文件。通过检查不证明登录、权限、网络或远端 API 可用，也不支持依赖任意 shell 初始化、额外环境变量或其他未声明解释器的包装器。使用 `#!/usr/bin/env node` 的包装器可以通过固定后的 `node` 选择运行；更复杂包装器需要在同样的后台环境下单独诊断。

本契约只增加安装前的本地验证。安装仍只写配置，`start`、`stop`、`restart` 的行为和配置写入回滚规则保持不变；运行中的服务遇到不同配置仍要求先停止。
