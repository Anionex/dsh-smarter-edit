# DSH Smarter Edit

[English](README.md)

[![npm version](https://img.shields.io/npm/v/@anionex/dsh-smarter-edit?style=flat-square)](https://www.npmjs.com/package/@anionex/dsh-smarter-edit)
[![License](https://img.shields.io/github/license/Anionex/dsh-smarter-edit?style=flat-square)](LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/Anionex/dsh-smarter-edit/ci.yml?branch=main&style=flat-square&label=CI)](https://github.com/Anionex/dsh-smarter-edit/actions/workflows/ci.yml)
[![TypeScript](https://img.shields.io/npm/types/@anionex/dsh-smarter-edit?style=flat-square)](https://www.npmjs.com/package/@anionex/dsh-smarter-edit)
[![GitHub release](https://img.shields.io/github/v/release/Anionex/dsh-smarter-edit?style=flat-square&label=release)](https://github.com/Anionex/dsh-smarter-edit/releases)

**为 DeepSeek Harness 提供更好的编辑接口。**

DSH 原生 `edit` 要求 coding model 重新构造精确的源码字符串，并通过结构化 JSON
参数同时发送修改前和修改后的代码。

DSH Smarter Edit 用兼容 Codex 的 freeform `apply_patch` 替换这套接口，让模型
直接用 diff 表达代码变化。
它的目标是减少编辑协议本身造成的失败和 token 开销。

```diff
*** Begin Patch
*** Update File: src/app.ts
@@
-const result = oldMethod(value)
+const result = newMethod(value)
*** End Patch
```

模型描述代码变化，不再重新构造精确的 `old_string` / `new_string` 参数对。

**让模型把 token 用在修改代码上，而不是满足编辑协议。**

![DSH Smarter Edit：为 DeepSeek Harness 提供更好的编辑接口](assets/hero.png)

## 为什么需要它

Coding model 本来只需要解决一个问题：代码应该怎么改。DSH 原生编辑协议又强加
了三项工作。

### 1. 精确重构旧源码

原生 `edit(file_path, old_string, new_string)` 要求模型重新生成已经读取过的
源码，并让 `old_string` 与文件内容精确匹配：

```text
模型知道代码应该怎么改
        ↓
old_string 的空白、缩进或字符与文件不完全一致
        ↓
编辑失败
```

这是**协议失败**，不是编程失败。Smarter Edit 从模型可见接口中移除精确字符串
参数对，改用带上下文的 patch hunk 定位修改。

### 2. 重复输出源码

精确字符串编辑要求模型同时输出已有代码块和新代码块，而两者的大部分内容往往
相同：

```text
old_string = 已经存在的源码
new_string = 大量相同源码 + 实际变化
```

Patch 只表达变化行和定位所需的上下文：

```diff
 必要上下文
-变化前
+变化后
 必要上下文
```

预期的 token 节省来自少重复旧源码、少重复未变化源码、少 JSON escaping，以及
减少精确匹配失败后的 retry。在受控 A/B 测试给出结果前，维护者不会公布具体
节省比例。

### 3. 结构化 JSON 开销

模型还必须把多行源码编码进工具 schema：

```json
{
  "old_string": "...",
  "new_string": "..."
}
```

Quoting、escaping 和精确匹配字段属于编辑协议，不属于代码变化本身。Freeform
`apply_patch` 让模型直接生成编辑语言。

## OpenAI 的证据

OpenAI 把 `apply_patch` 改为具名 freeform 工具接口。其
[官方模型指南](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-5.2)
报告称，与 JSON 格式的 function calling 相比，这项改动在测试中让
`apply_patch` 失败率**降低了 35%**。

该结果衡量的是 `apply_patch` 调用失败，不是任务成功率、SWE-bench 成绩或 token
节省比例。它证明工具接口设计本身会显著影响编辑可靠性。

## 为什么读取表示也会影响精确编辑

精确字符串编辑要求模型看到的源码表示与 mutation tool 实际匹配的内容一致。
如果读取层添加行号栏、把 tab 显示为空格，或改变换行格式，而编辑工具仍匹配
原始文件，模型就必须在每次编辑前正确逆转这种转换。

Claude Code 的公开 issue 报告记录了这类失败：

- [#13152](https://github.com/anthropics/claude-code/issues/13152) 报告读取输出把
  tab 显示为空格，随后精确匹配编辑失败。
- [#28831](https://github.com/anthropics/claude-code/issues/28831) 报告带 tab
  缩进的 CRLF 文件出现多行匹配不可靠，并把读取格式列为可能原因之一。
- [#54876](https://github.com/anthropics/claude-code/issues/54876) 报告读取输出
  使用 LF，而实际文件使用 CRLF。
- [#40471](https://github.com/anthropics/claude-code/issues/40471) 报告在 tab
  缩进文件上反复经历编辑失败、重试、回退到 Python/Bash 的循环。

这些是另一个 harness 的用户 issue 报告，不是 DSH 读取实现的证据。Smarter Edit
只处理这个问题的编辑端；原始源码读取属于另一项 harness 能力。

## 其他能力

除替换模型可见的编辑协议外，Smarter Edit 还支持：

- 多个有序 hunk；
- 一个 patch 中包含多个文件；
- 新增、更新、移动和删除操作；
- Codex 兼容的上下文匹配；
- 失败原子的完整预演与回滚；
- DSH 原生 diff 展示。

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
