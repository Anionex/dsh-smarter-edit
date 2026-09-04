# DSH Apply Patch

[English](README.md)

这是一个可移植的 DeepSeek Harness Profile Bundle。它会把模型可见的原生 `edit(file_path, old_string, new_string)` 替换为兼容 Codex 的 `apply_patch` 工具。通过 pi-ai 使用 OpenAI Responses 的路由会采用 provider 原生的 freeform custom-tool 传输。

在该路由上，模型直接发送原始 patch 文本，而不是 JSON 对象：

```diff
*** Begin Patch
*** Update File: src/app.ts
@@
-old code
+new code
*** Add File: src/utils.ts
+export const ready = true
*** Delete File: src/legacy.ts
*** End Patch
```

一次调用可以对多个文件执行 Add、Update、Move 和 Delete，每个 Update 也可以包含多个有序 hunk。

## 与原生 edit 对比

| 能力 | `apply_patch` | 原生 `edit` |
| --- | --- | --- |
| 多文件、多 hunk 修改 | 一次调用内有序完成 | 每次调用完成一处精确替换 |
| 匹配方式 | 有序上下文匹配，并支持空白及 Unicode 标点回退 | 精确匹配 `old_string` |
| 审查输出 | Unified diff、操作摘要及 DSH 原生 diff 卡片 | DSH 原生 diff 卡片 |
| 多文件普通失败 | 完整预演，失败后回滚 | 已完成的各次调用不会一起回滚 |
| 模型 token 开销 | 相关修改通常更低，但 patch 语法有标记开销 | 单个很小的精确替换通常更低 |
| 模型传输 | 通过 pi-ai 发送原始 OpenAI custom-tool 输入 | 普通 JSON function 参数 |
| 主要代价 | 一个范围较大的 patch 可同时修改或删除多个文件 | 影响范围更窄，但复杂修改需要更多调用 |

## Codex 对齐

Lark grammar 与 OpenAI Codex 提交 `8e6a44b428e31f91b21edc97904fcdf4f0931ade` 逐字节相同。解析状态机、有序 replacement 计算、四阶段序列匹配、context 行处理和 `PreserveLineEndings` 文件重建，均按该版本机制移植为 TypeScript。测试会执行官方完整的 25 个可移植场景：24 个与上游最终状态完全相同，scenario 015 用于断言下述事务差异。

唯一有意不同的是失败处理：上游 scenario 015 规定后续操作失败时保留之前的写入；本插件为满足 DSH 所要求的失败原子性，在外层先预演全部操作并在失败时回滚。这个外层包装不改变 patch grammar，也不改变当前 DSH sandbox 允许范围内的成功结果。

## 保证

- 修改目标前，先解析并验证完整 patch。
- 按 Codex 的匹配顺序定位 hunk：精确匹配、忽略行尾空白、忽略两侧空白、统一 Unicode 标点与空格。
- 使用 Codex 的 `PreserveLineEndings` 模式：上下文行保留原换行，插入行采用文件中首次出现的换行格式，更新仍遵循 Codex 历史上的末尾补换行行为。
- 相对路径从 Session 工作目录解析，同时接受绝对路径并跟随符号链接；权限边界完全沿用 DSH 当前 sandbox。
- 提交前先在同目录暂存全部新内容；发布不会覆盖最后检查后并发创建的路径；原文件被原子捕获为备份并复验；普通可检测失败会逆序恢复已经发布的目标。
- 返回标准 unified diff 和操作摘要。
- 通过 DSH 官方 keyed toolview slot 注册对话行，并用原生 `DiffBlock` 展示已应用的结构化 diff 元数据。
- 插件生效时，从模型工具列表中移除原生 `edit` 和旧版 `str_replace_editor`，并移除原生 edit 提示；卸载插件后恢复原有表面。

这里保证的是**失败原子性**，不是跨文件的崩溃安全事务。解析、预演、暂存、提交或复验发生普通可处理错误时，只要回滚成功，目标文件不会留下部分修改。进程被强制终止、内核或电源故障、回滚自身发生 I/O 错误时仍可能留下恢复文件；普通宿主文件系统没有通用的崩溃原子多文件事务。

## Freeform 传输

DSH `0.1.x` 的公开工具定义只有 JSON Schema，并且到 provider adapter 之前会丢弃 custom-tool 元数据。本插件在受支持 alpha 与 rc 版本共有的请求冻结模型快照边界 `PiAiAdapter.current()` 安装一个范围严格、引用计数、可卸载的桥，只给结构完全匹配的 `apply_patch` 增加随包附带的 OpenAI Lark grammar。

在 pi-ai OpenAI Responses 路由上，桥无需模型能力标志就会选择 grammar custom-tool 传输。provider 请求包含 OpenAI `type: "custom"` 工具及原始输入。没有 freeform custom-tool 原语的其他 provider 协议仍使用自身的普通 JSON 工具传输；插件不会因此禁用这些模型。具体而言，pi-ai 的 Anthropic Messages 和 Google Generative AI serializer 无法提供 provider 线上的原始 custom-tool 输入。

插件通过 DSH 公开的 `llm/stream` middleware，在 DSH 组装、执行或持久化已完成工具调用之前移除临时单字段 envelope。后续模型步骤重放原始 Session 历史时，pi-ai replay bridge 只在 adapter 内部临时恢复该 envelope。因此已完成调用的实时参数、Session 日志和轨迹参数视图都是原始 patch 文本，且不会破坏下一模型步骤。

## 安装

从本地 checkout 安装：

```sh
pnpm install --frozen-lockfile
pnpm run check
pnpm pack

dsh plugin --profile web add ./anionex-dsh-apply-patch-0.1.3.tgz
dsh --profile web --dump-config | grep tool-apply-patch
```

从 npm 包安装，一条命令即可：

```sh
dsh plugin --profile desktop add @anionex/dsh-apply-patch
dsh plugin --profile web add @anionex/dsh-apply-patch
dsh plugin --profile headless add @anionex/dsh-apply-patch
```

修改 bundle 列表后，需要重启正在运行的 Profile，并新建 Session。

## 运行前提

- DSH `>=0.1.1-rc.1 <0.2.0`。
- 若要求 provider 线上的 freeform custom-tool 传输，需要使用 pi-ai OpenAI Responses 路由；其他 adapter 保留自身的工具协议。
- 当前 DSH sandbox 允许写入。`workspace-write` 保留自身的工作区边界；`danger-full-access` 可以使用工作区外的绝对路径和父级相对路径。

## 语法

支持的操作：

```diff
*** Add File: relative/path.ts
+新增文件的每一行都以 + 开头
*** Delete File: relative/obsolete.ts
*** Update File: relative/current.ts
*** Move to: relative/renamed.ts
@@ 可选的函数或段落上下文
 不变上下文
-删除行
+新增行
*** End of File
```

`Move to` 可省略；`End of File` 会把 hunk 锚定到文件尾；只有新增行的 update hunk 会追加到文件尾。相对路径从 Session 工作目录解析；DSH 当前 sandbox 允许时，也接受绝对路径和父级相对路径。重复文件段按 patch 顺序求值，因此每个操作都能看到本次调用中之前操作的结果。Add 指向已存在文件时会替换该文件，与 Codex 行为一致。

## 配置

Profile patch 默认值：

```yaml
- id: tool-apply-patch
  config:
    replaceNativeEdit: true
```

只有在明确希望把 `edit`/`str_replace_editor` 与 `apply_patch` 同时暴露时才设置 `replaceNativeEdit: false`；它不影响 freeform 传输和事务语义。

## A/B Benchmark 口径

两个实验组应使用完全相同的任务 fixture、模型配置、sandbox 模式、提示文本、干净 workspace 快照和试验次数。原生 `edit` 与 `apply_patch` 对比以下指标：

| 指标 | 定义 |
| --- | --- |
| Tool calls | 完成前调用修改工具的总次数 |
| Failure rate | 被拒绝的修改调用数 / 修改调用总数 |
| Output tokens | 完整任务的 assistant 输出 token |
| Rounds | 最终回答前的模型请求 step 数 |
| First-test pass | 第一次执行测试即退出 0 |
| Final success | fixture 的所有验收检查通过 |
| Wall time | 用户请求被接受到最终结果的时间 |

如果记录到的 provider 请求把 `apply_patch` 描述为 `type: "function"`，该次试验不能计入 freeform 组；有效试验必须是 OpenAI `type: "custom"` 且 `format.syntax: "lark"`。

## 开发

```sh
pnpm peers check
pnpm run check
```

测试会运行 Codex 官方完整场景集（24 个最终状态完全一致，另加 scenario 015 的有意回滚差异），并覆盖定向 parser/matcher 用例、绝对/父级相对/symlink 路径、预演隔离、注入提交故障后的回滚、暂存目录清理、并发修改检测、工具注册、原生 edit 的可逆过滤、包结构、DSH 原始调用还原，以及截获 pi-ai OpenAI 请求体来证明 custom-tool 线协议。

纯引擎从 `@anionex/dsh-apply-patch/engine` 导出，不依赖 Cordis；DSH 适配仅位于 `src/host.ts` 和 `src/index.ts`。
