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
2. 日常入口极简，完整目录隐藏在 `npm run help -- --all`。
3. 命令、状态和关键数字要一眼可见。
4. 颜色只用于扫描：命令、状态、分组、提示。
5. 支持纯文本退化，不能依赖颜色表达唯一含义。
6. 错误和诊断要给下一步动作，不只 dump 堆栈。
7. 后台/同步类命令优先展示当前状态，再展示细节。
8. 数据查看类命令优先展示事实本身，再展示元数据。

## 项目内实现

共享渲染层：

```text
scripts/lib/terminal.mjs
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

脚本可以保留 JSON 输出，但 text 输出应尽量走共享渲染层。

## 改造范围

面向人的命令使用共享渲染层：

- `help`
- `messages`
- `lark-im-service status`
- `lark-im-service tail`
- `doctor`
- `sync-status`
- `lark-im-quality`
- `lark-im-lag-check`

内部命令可以继续优先输出 JSON/JSONL：

- worker 日志
- 单轮 sync summary
- enrichment 批处理 summary
- capability/cursor probe report

这些命令的输出常被其他脚本读取，机器可读性优先于视觉优化。
