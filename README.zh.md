# DSH Smarter Edit

[English](README.md)

[![npm version](https://img.shields.io/npm/v/@anionex/dsh-smarter-edit?style=flat-square)](https://www.npmjs.com/package/@anionex/dsh-smarter-edit)
[![License](https://img.shields.io/github/license/Anionex/dsh-smarter-edit?style=flat-square)](LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/Anionex/dsh-smarter-edit/ci.yml?branch=main&style=flat-square&label=CI)](https://github.com/Anionex/dsh-smarter-edit/actions/workflows/ci.yml)
[![TypeScript](https://img.shields.io/npm/types/@anionex/dsh-smarter-edit?style=flat-square)](https://www.npmjs.com/package/@anionex/dsh-smarter-edit)
[![GitHub release](https://img.shields.io/github/v/release/Anionex/dsh-smarter-edit?style=flat-square&label=release)](https://github.com/Anionex/dsh-smarter-edit/releases)

**为 DeepSeek Harness 提供更适合 coding agent 的文件编辑接口。**

DSH Smarter Edit 用兼容 Codex 的 freeform `apply_patch` 替换 DSH
模型可见的精确字符串 `edit`。Coding agent 可以在一次调用中表达跨多个文件的
多个 hunk；DSH 会保留原始 patch，并通过原生 diff UI 展示结果。

![DSH Smarter Edit：为 DeepSeek Harness 提供更好的文件编辑接口](assets/hero.png)

## 为什么需要它

DSH 原生 `edit(file_path, old_string, new_string)` 很适合单个、小范围且唯一的
精确替换。面对相关修改时，模型通常需要这样调用：

```text
edit(fileA, old1, new1)
edit(fileA, old2, new2)
edit(fileB, old3, new3)
```

每次调用都有一层 JSON 参数，并要求模型复现精确的源码子串。只要某个子串匹配
失败，agent 就可能需要重新读取文件、增加一个模型 round，再发起一次修改调用。

DSH Smarter Edit 把这些修改合并为一个编辑动作：

```diff
*** Begin Patch
*** Update File: fileA
@@
-old1
+new1
@@
-old2
+new2
*** Update File: fileB
@@
-old3
+new3
*** End Patch
```

一个模型动作包含三处替换、执行顺序和文件边界。单个微小精确替换仍适合原生
`edit`；`apply_patch` 主要解决 coding agent 在复杂、相关修改中重复发送上下文
和工具调用的问题。

## 为什么选择 apply_patch

- **一次表达多个 hunk。** 多处修改不再要求每个 replacement 都调用一次工具。
- **一次规划多个文件。** 新增、更新、移动和删除共享同一套有序预演与失败边界。
- **用上下文定位，而非复现完整旧字符串。** Hunk 只携带定位修改所需的行，并按
  Codex 兼容顺序尝试匹配。
- **在支持的路由上直接发送模型输出。** OpenAI Responses 接收具名 freeform
  custom-tool 输入，不需要把 patch 变成经过 JSON 转义的字符串。

[OpenAI 官方文档](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-5.2)
报告称，具名 freeform `apply_patch` 函数在测试中让 `apply_patch` 的失败率
**降低了 35%**，对照对象是 JSON 格式方案。这个数字只描述 `apply_patch`
调用失败率，不代表任务成功率、SWE-bench 成绩或 token 节省比例。

这个接口面向相关修改减少编辑开销。合并修改可以减少重复的 tool-call envelope；
原始 patch 不需要 JSON quoting 和 escaping；每个 hunk 只复现定位所需的上下文，
不必为每处 replacement 单独复制完整 `old_string`。编辑失败减少后，也可能省去
reread 和 retry round。在项目自己的 A/B benchmark 给出数据前，维护者不会公布
具体 token 节省比例。

## 原生 edit 与 Smarter Edit 对比

| DSH 原生 `edit` | DSH Smarter Edit |
| --- | --- |
| 精确替换 `old_string` | 通过上下文 hunk 定位 |
| 通常每次调用完成一处替换 | 一次调用可包含多个有序 hunk |
| 跨文件修改需要多次工具调用 | 一个 patch 可覆盖多个文件 |
| 使用结构化 JSON 参数 | 支持的路由使用原始 freeform patch 输入 |
| 每次修改重复一段精确源码 | 每个 hunk 只重复定位所需的上下文 |
| 每次成功调用独立提交 | 对可处理的多文件失败先完整预演，再回滚 |
| 单个微小精确替换通常更短 | 设计目标是减少复杂相关修改的编辑协议开销 |

## 安装

把当前 npm 版本安装到 Desktop Profile：

```sh
dsh plugin --profile desktop add @anionex/dsh-smarter-edit
```

安装到其他 Profile 时，把 `desktop` 换成 `web` 或 `headless`。安装后重启正在
运行的 Profile，并新建 Session。

确认 bundle 已挂载：

```sh
dsh --profile desktop --dump-config | grep tool-apply-patch
```

## 工作原理

1. 模型发送一个位于 `*** Begin Patch` 与 `*** End Patch` 之间的 patch。
2. Parser 构建有序操作计划；host 通过当前 DSH sandbox 解析每个路径。
3. 引擎预演完整计划、暂存替换内容、提交目标并复验结果；可处理的失败会触发
   逆序回滚。
4. 工具返回操作摘要、标准 unified diff 和按 hunk 组织的展示元数据。
5. DSH 在 Session 历史中保存原始 patch。附带的 Web 客户端通过 DSH 官方
   keyed toolview slot 注册，并使用原生 `DiffBlock` 回放结果。

替换模式生效时，插件会从模型表面移除 `edit`、`write` 和旧版
`str_replace_editor` 及其提示区块；卸载插件后恢复原有工具。纯引擎从
`@anionex/dsh-smarter-edit/engine` 导出，DSH 适配位于 `src/host.ts` 和
`src/index.ts`。

## 兼容性与限制

- DSH `>=0.1.1-rc.1 <0.2.0`。
- 包开发和直接调用引擎需要 Node.js `^22.19.0 || >=24.0.0`。
- 支持 `desktop`、`web` 和 `headless` Profile。
- Provider 线上的原始 custom-tool 输入需要使用 pi-ai OpenAI Responses 路由。
  Anthropic Messages 和 Google Generative AI serializer 没有 freeform
  custom-tool 原语，因此保留普通 JSON 工具传输。
- 需要当前 DSH sandbox 授权写入。`workspace-write` 保留已配置的边界；
  `danger-full-access` 可以允许工作区外的绝对路径和父级相对路径。
- 只有一个微小精确替换时，原生 `edit` 可能使用更少 token。
- 一个范围较大的 patch 可以修改或删除多个文件；范围较大时应审查请求 patch
  和结果 diff。
- 缺少展示元数据的历史调用会降级为普通输出，不会从不受信任文本重建 diff。

项目仍处于 1.0 之前。兼容目标是声明的 DSH `0.1.x` 范围；发布验收会把 tarball
安装到干净 Profile。

## Codex 兼容性

Lark grammar 与 OpenAI Codex 提交
`8e6a44b428e31f91b21edc97904fcdf4f0931ade` 逐字节相同。解析状态机、有序
replacement 计算、四阶段序列匹配、context 行处理和
`PreserveLineEndings` 文件重建，均按该版本机制移植为 TypeScript。

测试会执行官方完整的 25 个可移植场景。其中 24 个与上游最终状态完全相同。
Scenario 015 断言唯一有意保留的差异：上游在后续操作失败时保留之前的写入；
本插件会预演全部操作，并回滚已经发布的目标。

项目自身采用 MIT License。Codex 派生 grammar、fixture 与移植实现保留其
Apache-2.0 license 和 NOTICE 归因，位于 `third_party/codex/`；详见
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 安全与原子性

- 修改目标前解析并验证完整 patch。
- 按 Codex 顺序定位 update hunk：精确匹配、忽略行尾空白、忽略两侧空白、统一
  Unicode 标点与空格。
- 使用 Codex 的 `PreserveLineEndings` 模式。Context 行保留原换行，插入行采用
  文件中首次出现的换行格式，update 保留 Codex 历史上的末尾补换行行为。
- 相对路径从 Session 工作目录解析，同时接受绝对路径并跟随符号链接；权限边界
  沿用 DSH 当前 sandbox。
- 提交前暂存全部新内容，不覆盖最后检查后并发创建的路径，捕获并验证备份，复验
  最终内容，并在可检测失败后逆序恢复已经发布的目标。
- 返回标准 unified diff 和操作摘要。

这里保证的是**失败原子性**，不是崩溃原子性。解析、预演、暂存、提交或复验发生
可处理错误时，只要回滚成功，目标文件不会留下部分修改。进程被强制终止、内核或
电源故障、回滚自身发生 I/O 错误时仍可能留下恢复文件。

## Freeform 传输

DSH `0.1.x` 公开 JSON Schema 工具定义，并在到达 provider adapter 前移除
custom-tool 元数据。本插件在请求冻结的模型快照边界 `PiAiAdapter.current()`
安装范围严格、引用计数的 bridge，只给结构完全匹配的 `apply_patch` schema
增加随包附带的 OpenAI Lark grammar。

在 pi-ai OpenAI Responses 路由上，provider 请求包含 OpenAI
`type: "custom"` 工具及原始输入。其他 provider 协议保留自身的普通 JSON
工具传输。

插件通过 DSH 公开的 `llm/stream` middleware，在 DSH 组装、执行或持久化已完成
调用之前移除 pi-ai 的临时单字段 envelope。后续模型步骤重放原始 Session 历史
时，replay bridge 只在 adapter 内部恢复该 envelope。因此实时参数、Session
日志和 Trajectory 参数视图都保留原始 patch 文本。

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

`Move to` 可省略；`End of File` 会把 hunk 锚定到文件尾；只有新增行的 update
hunk 会追加到文件尾。相对路径从 Session 工作目录解析；DSH 当前 sandbox 允许
时，也接受绝对路径和父级相对路径。重复文件段按 patch 顺序执行，因此每个操作
都能看到本次调用中之前操作的结果。Add 指向已存在文件时会替换该文件，与 Codex
行为一致。

## 配置

Profile patch 默认值：

```yaml
- id: tool-apply-patch
  config:
    replaceNativeEdit: true
```

只有在明确希望把 `edit`、`write` 和 `str_replace_editor` 与 `apply_patch`
同时暴露时才设置 `replaceNativeEdit: false`；它不影响 freeform 传输和事务语义。

## Benchmark

首个计划中的 A/B 对比会使用 DeepSeek V4 Flash，在同一批 coding fixture 上比较
DSH 原生 `edit` 与 DSH Smarter Edit。两组必须使用相同的 prompt、模型配置、
reasoning effort、sandbox、干净 workspace 快照和 trial 数量。

| 指标 | 定义 |
| --- | --- |
| Mutation calls | 完成前调用文件修改工具的总次数 |
| Mutation failure rate | 被拒绝或失败的修改调用数 / 修改调用总数 |
| Output tokens | 完整任务的 assistant 输出 token |
| Rounds | 最终回答前的模型请求 step 数 |
| First-test pass | 第一次执行测试即退出 0 |
| Final success | fixture 的所有验收检查通过 |
| Wall time | 用户请求被接受到最终结果的时间 |

如果记录到的 provider 请求把 `apply_patch` 描述为 `type: "function"`，该次试验
不能计入 freeform 组。有效试验必须是 OpenAI `type: "custom"` 且
`format.syntax: "lark"`。只有完成多次受控试验后，才把实测结果写入 README。

## 开发

```sh
pnpm install --frozen-lockfile
pnpm peers check
pnpm run check
```

测试覆盖 Codex 官方场景集、parser 与 matcher 行为、sandbox 路径、预演隔离、
故障回滚、清理、并发修改检测、工具注册、原生工具过滤、包结构、DSH 原始调用
还原、原生 diff 展示和捕获的 OpenAI 请求序列化。

修改行为或打包前，请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 安全与社区

- 通过 [SECURITY.md](SECURITY.md) 私下报告安全问题。
- 通过 [SUPPORT.md](SUPPORT.md) 获取使用帮助。
- 按 [CONTRIBUTING.md](CONTRIBUTING.md) 和
  [issue tracker](https://github.com/Anionex/dsh-smarter-edit/issues) 提交修改建议。
- 在 [CHANGELOG.md](CHANGELOG.md) 查看版本历史。
- 社区参与遵循 [Code of Conduct](CODE_OF_CONDUCT.md)。

由 [Anionex](https://github.com/Anionex) 维护，采用
[MIT License](LICENSE)。
