# DSH Smarter Edit

[English](README.md)

[![npm version](https://img.shields.io/npm/v/@anionex/dsh-smarter-edit?style=flat-square)](https://www.npmjs.com/package/@anionex/dsh-smarter-edit)
[![License](https://img.shields.io/github/license/Anionex/dsh-smarter-edit?style=flat-square)](LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/Anionex/dsh-smarter-edit/ci.yml?branch=main&style=flat-square&label=CI)](https://github.com/Anionex/dsh-smarter-edit/actions/workflows/ci.yml)
[![TypeScript](https://img.shields.io/npm/types/@anionex/dsh-smarter-edit?style=flat-square)](https://www.npmjs.com/package/@anionex/dsh-smarter-edit)
[![GitHub release](https://img.shields.io/github/v/release/Anionex/dsh-smarter-edit?style=flat-square&label=release)](https://github.com/Anionex/dsh-smarter-edit/releases)

**在 DeepSeek Harness 中，用一次有序、原子、可审查的 `apply_patch` 调用完成多文件修改。**

DSH Smarter Edit 会把模型可见的原生 `edit`、原生 `write` 与旧版 `str_replace_editor` 替换为兼容 Codex 的 `apply_patch` 工具。模型可以通过有序 hunk 新增、更新、移动和删除多个文件。插件会先预演完整 patch，在普通可处理失败时回滚，并用 DSH 原生 diff UI 展示结果。

![DSH Smarter Edit：一次有序、原子的 apply_patch 调用完成多文件修改](assets/hero.png)

## 功能亮点

- **一次修改相关文件。** 一个 patch 可以通过多个有序 hunk 新增、更新、移动和删除文件。
- **普通失败保持原子性。** 引擎会解析、解析路径、预演、暂存、提交并复验全部操作；检测到失败后逆序回滚已经发布的目标。
- **在 OpenAI Responses 上发送原始 patch。** 模型把 `*** Begin Patch` 内容作为 custom-tool 输入；Session 日志和 Trajectory 参数视图保留原始文本。
- **在对话中审查修改。** 每次成功调用都会返回 unified diff 和结构化展示元数据；附带的 Web 客户端通过 DSH 官方 keyed toolview slot 注册，并使用原生 `DiffBlock`。
- **匹配 Codex patch 行为。** Grammar 与固定的 Codex 版本逐字节一致；测试运行其 25 个可移植场景，并记录唯一的事务差异。
- **作为标准 DSH bundle 安装。** 包支持 `desktop`、`web` 和 `headless` Profile；卸载后恢复原来的文件修改工具。

## 快速开始

把当前 npm 版本安装到 Desktop Profile：

```sh
dsh plugin --profile desktop add @anionex/dsh-smarter-edit
```

安装到其他 Profile 时，把 `desktop` 换成 `web` 或 `headless`。安装后重启正在运行的 Profile，并新建 Session。

模型随后直接发送原始 patch 文本：

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

确认 bundle 已挂载：

```sh
dsh --profile desktop --dump-config | grep tool-apply-patch
```

## 与原生 edit 对比

| 能力 | `apply_patch` | 原生 `edit` |
| --- | --- | --- |
| 多文件、多 hunk 修改 | 一次调用内有序完成 | 每次调用完成一处精确替换 |
| 匹配方式 | 有序上下文匹配，并支持空白及 Unicode 标点回退 | 精确匹配 `old_string` |
| 审查输出 | Unified diff、操作摘要及 DSH 原生 diff 卡片 | DSH 原生 diff 卡片 |
| 多文件普通失败 | 完整预演，失败后回滚 | 已完成的各次调用不会一起回滚 |
| 模型 token 开销 | 相关修改往往更低，但 patch 语法有标记开销 | 单个很小的精确替换往往更低 |
| 模型传输 | 通过 pi-ai 发送原始 OpenAI custom-tool 输入 | 普通 JSON function 参数 |
| 主要代价 | 一个范围较大的 patch 可同时修改或删除多个文件 | 影响范围更窄；复杂修改需要更多调用 |

## 使用场景

- 一次完成必须共同成功或共同失败的跨文件修改。
- 通过有序代码上下文定位修改，避开脆弱的整段精确字符串替换。
- 在同一次编辑中新增、重命名和删除文件。
- 保留可回放的原始 patch，同时在对话中查看原生 diff 卡片。

## 工作原理

1. 模型发送一个位于 `*** Begin Patch` 与 `*** End Patch` 之间的 patch。
2. Parser 构建有序操作计划；host 通过当前 DSH sandbox 解析每个路径。
3. 引擎预演完整计划、暂存替换内容、提交目标并复验结果；普通可处理失败会触发逆序回滚。
4. 工具返回操作摘要、标准 unified diff 和按 hunk 组织的展示元数据。
5. DSH 在 Session 历史中保存原始 patch；Web 客户端用展示元数据回放原生 diff 卡片。

纯引擎从 `@anionex/dsh-smarter-edit/engine` 导出，不依赖 Cordis。DSH 适配位于 `src/host.ts` 和 `src/index.ts`。

## 保证

- 修改目标前，先解析并验证完整 patch。
- 按 Codex 的匹配顺序定位 hunk：精确匹配、忽略行尾空白、忽略两侧空白、统一 Unicode 标点与空格。
- 使用 Codex 的 `PreserveLineEndings` 模式：上下文行保留原换行，插入行采用文件中首次出现的换行格式，更新仍遵循 Codex 历史上的末尾补换行行为。
- 相对路径从 Session 工作目录解析，同时接受绝对路径并跟随符号链接；权限边界沿用 DSH 当前 sandbox。
- 提交前先在同目录暂存全部新内容；发布不会覆盖最后检查后并发创建的路径；原文件被原子捕获为备份并复验；普通可检测失败会逆序恢复已经发布的目标。
- 返回标准 unified diff 和操作摘要。
- 通过 DSH 官方 keyed toolview slot 注册对话行，并用原生 `DiffBlock` 展示已应用的结构化 diff 元数据。
- 插件生效时，从模型工具列表中移除原生 `edit`、原生 `write` 和旧版 `str_replace_editor`，并移除它们的提示区块；卸载插件后恢复原有表面。

这里保证的是**失败原子性**，不是跨文件的崩溃安全事务。解析、预演、暂存、提交或复验发生普通可处理错误时，只要回滚成功，目标文件不会留下部分修改。进程被强制终止、内核或电源故障、回滚自身发生 I/O 错误时仍可能留下恢复文件；普通宿主文件系统没有通用的崩溃原子多文件事务。

## 兼容性与状态

- DSH `>=0.1.1-rc.1 <0.2.0`。
- 包开发和直接调用引擎需要 Node.js `^22.19.0 || >=24.0.0`。
- 支持 `desktop`、`web` 和 `headless` Profile。
- 若要求 provider 线上的原始 custom-tool 输入，需要使用 pi-ai OpenAI Responses 路由；其他 adapter 保留自身的工具协议。
- 需要当前 DSH sandbox 授权写入。`workspace-write` 保留已配置的边界；`danger-full-access` 可以允许工作区外的绝对路径和父级相对路径。
- 项目仍处于 1.0 之前；兼容目标是声明的 DSH `0.1.x` 范围，发布验收会把 tarball 安装到干净 Profile。

## 限制

- 一个范围较大的 patch 可以修改或删除多个文件；修改范围较大时应审查请求 patch 和结果 diff。
- 只有一个很小的精确替换时，原生 `edit` 可能使用更少 token。
- Anthropic Messages 和 Google Generative AI 路由使用普通 JSON 工具传输，因为这些 pi-ai serializer 不提供 provider 线上的原始 custom-tool 输入。
- 失败原子性只覆盖可检测错误和成功回滚；它不覆盖进程被终止、电源或内核故障、回滚 I/O 失败。
- 缺少展示元数据的历史成功调用会降级为普通输出，不会从不受信任文本重新构造 diff。

## Codex 对齐

Lark grammar 与 OpenAI Codex 提交 `8e6a44b428e31f91b21edc97904fcdf4f0931ade` 逐字节相同。解析状态机、有序 replacement 计算、四阶段序列匹配、context 行处理和 `PreserveLineEndings` 文件重建，均按该版本机制移植为 TypeScript。测试会执行官方完整的 25 个可移植场景：24 个与上游最终状态完全相同，scenario 015 用于断言下述事务差异。

唯一有意不同的是失败处理：上游 scenario 015 规定后续操作失败时保留之前的写入；本插件为满足 DSH 所要求的失败原子性，在外层先预演全部操作并在失败时回滚。这个外层包装不改变 patch grammar，也不改变当前 DSH sandbox 允许范围内的成功结果。

项目自身采用 MIT License。Codex 派生 grammar、fixture 与移植实现保留其 Apache-2.0 license 和 NOTICE 归因，位于 `third_party/codex/`；详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## Freeform 传输

DSH `0.1.x` 的公开工具定义只有 JSON Schema，并且到 provider adapter 之前会丢弃 custom-tool 元数据。本插件在受支持 alpha 与 rc 版本共有的请求冻结模型快照边界 `PiAiAdapter.current()` 安装一个范围严格、引用计数、可卸载的桥，只给结构完全匹配的 `apply_patch` 增加随包附带的 OpenAI Lark grammar。

在 pi-ai OpenAI Responses 路由上，桥无需模型能力标志就会选择 grammar custom-tool 传输。provider 请求包含 OpenAI `type: "custom"` 工具及原始输入。没有 freeform custom-tool 原语的其他 provider 协议仍使用自身的普通 JSON 工具传输；插件不会因此禁用这些模型。

插件通过 DSH 公开的 `llm/stream` middleware，在 DSH 组装、执行或持久化已完成工具调用之前移除 pi-ai 的临时单字段 envelope。后续模型步骤重放原始 Session 历史时，replay bridge 只在 adapter 内部临时恢复该 envelope。因此已完成调用的实时参数、Session 日志和 Trajectory 参数视图都是原始 patch 文本，且不会破坏下一模型步骤。

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

只有在明确希望把 `edit`、`write` 和 `str_replace_editor` 与 `apply_patch` 同时暴露时才设置 `replaceNativeEdit: false`；它不影响 freeform 传输和事务语义。

## 开发

```sh
pnpm install --frozen-lockfile
pnpm peers check
pnpm run check
```

测试会运行 Codex 官方完整场景集、定向 parser 和 matcher 用例、sandbox 路径用例、预演隔离、故障注入后的回滚、清理、并发修改检测、工具注册、原生 edit 过滤、包结构、DSH 原始调用还原、原生 diff 卡片展示及捕获的 OpenAI 请求序列化。

修改行为或打包前，请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。

<details>
<summary>A/B Benchmark 口径</summary>

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

</details>

## 安全与社区

- 通过 [SECURITY.md](SECURITY.md) 私下报告安全问题。
- 通过 [SUPPORT.md](SUPPORT.md) 获取使用帮助。
- 按 [CONTRIBUTING.md](CONTRIBUTING.md) 和 [issue tracker](https://github.com/Anionex/dsh-smarter-edit/issues) 提交修改建议。
- 在 [CHANGELOG.md](CHANGELOG.md) 查看版本历史。
- 社区参与遵循 [Code of Conduct](CODE_OF_CONDUCT.md)。

由 [Anionex](https://github.com/Anionex) 维护，采用 [MIT License](LICENSE)。
