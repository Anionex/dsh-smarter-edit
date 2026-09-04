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

## 自由格式传输

DSH `0.1.x` 对外提供用 JSON Schema 描述的工具定义，并在请求进入模型服务适配器
前移除 custom-tool 元数据。本插件在 `PiAiAdapter.current()` 这个模型快照冻结
位置加入一层范围受限、支持引用计数的适配，只为完全匹配的 `apply_patch`
schema 添加随包提供的 OpenAI Lark grammar。

通过 pi-ai 调用 OpenAI Responses 时，发送给 OpenAI 的请求包含
`type: "custom"` 工具和原始补丁文本。其他模型服务仍使用各自原有的 JSON 工具
传输方式。

插件使用 DSH 公开的 `llm/stream` 中间件，在 DSH 组装、执行或保存完整调用前，
移除 pi-ai 临时添加的单字段包装。后续模型步骤重放会话历史时，重放适配层只在
模型服务适配器内部恢复这层包装。因此实时参数、会话日志和 Trajectory 参数视图
都保留原始补丁文本。

## 包入口与结果展示

不依赖 DSH 的核心引擎从 `@anionex/dsh-smarter-edit/engine` 导出。DSH 适配代码
位于 `src/host.ts` 和 `src/index.ts`。

每次成功调用都会返回操作摘要、标准统一格式差异和按修改片段组织的展示元数据。
随包提供的 Web 客户端通过 DSH 官方 keyed toolview slot 注册，并使用原生
`DiffBlock` 展示结果。缺少展示元数据的历史调用会退回普通文本输出，不会从
不受信任的文本中重建差异。
