# 实现说明

[English](implementation.md) | [返回 README](../README.zh.md)

本文面向项目维护者和代码审查者，记录与兼容性、事务和模型服务传输有关的实现
细节。

## 与 Codex 对齐

随包提供的 Lark grammar 与 OpenAI Codex 提交
`8e6a44b428e31f91b21edc97904fcdf4f0931ade` 逐字节相同。解析状态机、有序
替换计算、四阶段序列匹配、上下文行处理和 `PreserveLineEndings` 文件重建逻辑，
均由该版本移植为 TypeScript。

测试会执行 Codex 官方的全部 25 个可移植场景，其中 24 个场景的最终文件状态与
上游完全相同。场景 015 检查唯一有意保留的差异：上游在后续操作失败时保留之前
的写入；本插件会先预演全部操作，并撤销已经提交的修改。

项目本身采用 MIT License。由 Codex 衍生的语法文件、测试样例和移植实现继续
采用 Apache-2.0 license，并保留 NOTICE 归因。这些文件位于
`third_party/codex/`，详情见
[THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)。

## 安全性与原子性

- 修改文件前解析并验证完整补丁。
- 按 Codex 的顺序定位更新片段：先精确匹配，再依次忽略行尾空白、行首行尾空白，
  最后统一 Unicode 标点和空格。
- 使用 Codex 的 `PreserveLineEndings` 模式。上下文行保留原来的换行符；新增行
  使用文件中首次出现的换行格式；更新操作保留 Codex 既有的文件末尾补换行行为。
- 相对路径从当前会话的工作目录解析，同时接受绝对路径并跟随符号链接。权限边界
  仍由 DSH 当前启用的沙箱决定。
- 提交前暂存所有新内容，不会覆盖最终检查后才由其他进程创建的路径；引擎会保存
  并验证备份、复查最终内容，并在检测到失败后按相反顺序恢复已提交的文件。
- 返回标准统一格式差异和操作摘要。

事务保证**失败原子性**，但不保证系统崩溃时的原子性。解析、预演、暂存、提交或
复验遇到可处理错误时，只要回滚成功，目标文件就不会留下部分修改。进程被强制
终止、内核或电源故障，以及回滚本身发生 I/O 错误时，仍可能留下恢复文件。

失败原子性并不能限制重试成本。任何一个操作失败，整份补丁都会被拒绝；重试时
必须再次提交完整补丁。插件没有设置固定的补丁大小上限，因此这项成本会随补丁
规模增长。

## 自由格式传输

DSH `0.1.x` 和 `0.2.1` 对外提供用 JSON Schema 描述的工具定义，并在请求进入模型服务
适配器前移除 custom-tool 元数据。本插件在 `PiAiAdapter.current()` 这个模型快照冻结
位置加入一层范围受限、支持引用计数的适配，只为完全匹配的 `apply_patch`
schema 添加随包提供的 OpenAI Lark grammar。适配同时覆盖请求级 `tools` 和 pi-ai 1.x
system 消息中的 `toolsAdded`，保留工具移除记录及无关历史。

通过 pi-ai 调用 OpenAI Responses 时，发送给模型服务的请求包含
`type: "custom"` 工具和原始补丁文本。支持 grammar custom tool 的 OpenAI Chat
Completions 路由同样接收 `type: "custom"`，Lark grammar 位于
`custom.format`，不会收到 `apply_patch` 的 JSON Schema function 定义。不支持
custom grammar tool 的其他模型服务仍使用各自原有的 JSON 工具传输方式。

部分兼容 OpenAI Completions 的模型服务会用临时 JSON 包装返回这段内容。适配层
接受 pi-ai 使用的 `patch` 和 `input` 字段。DeepSeek V4 路由有时会用
function 形态的 `arguments` 包装回复 custom 请求，其字符串值本身还可能包含
一层采用已知字段的 JSON 包装；只有最终能够还原出原始补丁文本时，适配层才会
逐层解包。含多个已知字段的对象，只有每个字段独立还原后得到的补丁字节完全相同
时才会被接受。重复字段名、未知字段、非字符串值、内容冲突和任意前缀文本仍会
被拒绝。
流式参数还原后的内容也必须与最终 ToolCallBlock 完全一致。

遇到非法包装、流式参数与最终参数不一致，或者工具调用缺少最终 block 时，插件
会把这次输入转换成一个固定的 rejected `apply_patch` 调用。DSH ToolRuntime
随后生成 `isError: true` 的工具结果，并明确提示使用原始补丁文本重试，因此
Agent 可以继续进入下一个模型 step。候选补丁不会被解析或执行，存在歧义的模型
服务包装也不会作为可执行参数持久化。适配层从 pi-ai 的 start event 保留调用
身份；模型服务未提供 ID 时会补充一个非空 ID；ID、工具名或 block 类型发生变化
时，只生成一个 rejected 调用。如果模型服务的传输连接在形成工具调用前就已
中断，该情况仍属于 LLM 传输失败。

插件使用 DSH 公开的 `llm/stream` 中间件，在 DSH 组装、执行或保存完整调用前，
移除这些临时包装。后续模型步骤重放会话历史时，重放适配层只在模型服务适配器
内部恢复 pi-ai 所需的包装。因此实时参数、会话日志和 Trajectory 参数视图都
保留原始补丁文本。

## 包入口与结果展示

不依赖 DSH 的核心引擎从 `@anionex/dsh-smarter-edit/engine` 导出。DSH 适配代码
位于 `src/host.ts` 和 `src/index.ts`。

每次成功调用都会返回操作摘要、标准统一格式差异和按修改片段组织的展示元数据。
随包提供的 Web 客户端通过 DSH 官方 keyed toolview slot 注册，并使用原生
`DiffBlock` 展示结果。缺少展示元数据的历史调用会退回普通文本输出，不会从
不受信任的文本中重建差异。
