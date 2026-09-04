# DSH Smarter Edit

[English](README.md)

[![npm version](https://img.shields.io/npm/v/@anionex/dsh-smarter-edit?style=flat-square)](https://www.npmjs.com/package/@anionex/dsh-smarter-edit)
[![License](https://img.shields.io/github/license/Anionex/dsh-smarter-edit?style=flat-square)](LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/Anionex/dsh-smarter-edit/ci.yml?branch=main&style=flat-square&label=CI)](https://github.com/Anionex/dsh-smarter-edit/actions/workflows/ci.yml)
[![TypeScript](https://img.shields.io/npm/types/@anionex/dsh-smarter-edit?style=flat-square)](https://www.npmjs.com/package/@anionex/dsh-smarter-edit)
[![GitHub release](https://img.shields.io/github/v/release/Anionex/dsh-smarter-edit?style=flat-square&label=release)](https://github.com/Anionex/dsh-smarter-edit/releases)

**为 DeepSeek Harness 提供更适合编码模型的文件编辑工具。**

DSH 原生 `edit` 工具要求编码模型重新构造精确的源码字符串，并通过结构化 JSON
参数同时提交修改前和修改后的代码。

DSH Smarter Edit 改用兼容 Codex 的自由格式 `apply_patch`，让模型直接通过差异
补丁描述代码变化。它希望减少工具参数格式造成的编辑失败和额外 token 消耗。

```diff
*** Begin Patch
*** Update File: src/app.ts
@@
-const result = oldMethod(value)
+const result = newMethod(value)
*** End Patch
```

模型只需描述哪些代码要变，不必重新构造精确的
`old_string` / `new_string` 参数对。

**让模型把 token 用在修改代码上，而不是满足编辑协议。**

![DSH Smarter Edit：为 DeepSeek Harness 提供更适合编码模型的文件编辑工具](assets/hero.png)

## 为什么需要它

编码模型本来只需要判断代码该怎么改。使用 DSH 原生 `edit` 时，它还得处理三件
与修改代码无关的事。

### 1. 重新拼出旧源码

原生 `edit(file_path, old_string, new_string)` 要求模型重新生成已经读取过的
源码，并让 `old_string` 与文件内容精确匹配：

```text
模型知道代码应该怎么改
        ↓
old_string 的空白、缩进或字符与文件不完全一致
        ↓
编辑失败
```

即使模型已经找对修改位置和内容，只要 `old_string` 的空白、缩进或字符与文件
不一致，编辑工具仍会拒绝这次操作。Smarter Edit 不再要求模型提供完整的精确
字符串参数对，而是通过带上下文的补丁片段定位修改。

### 2. 重复生成源码

精确字符串替换要求模型把旧代码块和新代码块都再写一遍，而两者的大部分内容
相同：

```text
old_string = 已经存在的源码
new_string = 大量相同源码 + 实际变化
```

补丁只保留变化行和定位所需的上下文：

```diff
 必要上下文
-变化前
+变化后
 必要上下文
```

这样可以减少重复的旧代码、未改代码和 JSON 转义，也能减少匹配失败后的重试。
在受控 A/B 测试给出结果前，维护者不会公布具体的 token 节省比例。

### 3. JSON 参数带来的额外工作

模型还必须把多行源码放进固定的 JSON 参数结构：

```json
{
  "old_string": "...",
  "new_string": "..."
}
```

引号、转义和完整的精确匹配字段都只是编辑工具的格式要求。自由格式
`apply_patch` 让模型直接生成补丁。

## OpenAI 的证据

OpenAI 把 `apply_patch` 改成具名的自由格式工具。其
[官方模型指南](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-5.2)
报告称，与 JSON 格式的函数调用相比，这项改动在测试中让
`apply_patch` 失败率**降低了 35%**。

该结果衡量的是 `apply_patch` 调用失败，不是任务成功率、SWE-bench 成绩或 token
节省比例。这个结果说明，编辑工具采用什么输入格式会直接影响可靠性。

## 精确字符串替换为什么脆弱

精确字符串替换只有在 `old_string` 与目标内容完全一致时才会成功。Claude Code
的公开问题展示了制表符、换行符等不可见细节怎样导致
`String to replace not found in file`：

- [#13152](https://github.com/anthropics/claude-code/issues/13152) 报告读取结果把
  制表符显示为空格，随后精确匹配失败。
- [#28831](https://github.com/anthropics/claude-code/issues/28831) 报告使用
  CRLF 换行和制表符缩进的文件出现多行匹配不可靠，并把读取格式列为可能原因。
- [#54876](https://github.com/anthropics/claude-code/issues/54876) 报告读取输出
  使用 LF，而实际文件使用 CRLF。
- [#40471](https://github.com/anthropics/claude-code/issues/40471) 报告编辑
  制表符缩进的文件时，工具反复失败、重试，最后改用 Python 或 Bash。

这些报告来自另一个编码工具，不能用来判断 DSH 的具体行为。它们揭示的是精确
字符串替换本身的弱点：模型除了决定怎样修改代码，还必须重现与修改目的无关的
文件细节。任何偏差都可能让工具拒绝编辑，继而触发重试或改用其他工具。

## 其他功能

除了改变模型使用的文件编辑工具，Smarter Edit 还支持：

- 按顺序执行多个修改片段；
- 新增、更新、移动和删除操作；
- Codex 兼容的上下文匹配；
- 提交前检查全部修改，失败时回滚；
- DSH 原生差异视图。

## 安装

把当前 npm 版本安装到 Desktop Profile：

```sh
dsh plugin --profile desktop add @anionex/dsh-smarter-edit
```

安装到其他 Profile 时，把 `desktop` 换成 `web` 或 `headless`。安装后重启正在
运行的 Profile，并新建会话。

确认插件已加载：

```sh
dsh --profile desktop --dump-config | grep tool-apply-patch
```

## 工作原理

1. 模型发送一个位于 `*** Begin Patch` 与 `*** End Patch` 之间的补丁。
2. Smarter Edit 验证完整补丁，根据上下文定位每处修改，再通过当前 DSH 沙箱写入
   文件。遇到可处理的失败时，它会撤销已经提交的修改。
3. DSH 保存原始补丁，并使用原生差异视图展示结果。

启用默认替换模式后，插件会从模型可用工具中移除 `edit`、`write` 和旧版
`str_replace_editor` 及其提示内容；卸载插件后会恢复这些工具。

## 兼容性与限制

- DSH `>=0.1.1-rc.1 <0.2.0`。
- 包开发和直接调用引擎需要 Node.js `^22.19.0 || >=24.0.0`。
- 支持 `desktop`、`web` 和 `headless` Profile。
- 需要当前 DSH 沙箱授权写入。`workspace-write` 保留已配置的边界；
  `danger-full-access` 可以允许工作区外的绝对路径和父级相对路径。
- 对可处理失败的回滚保护的是文件状态，不是重试成本。大型补丁中只要一个修改
  片段失败，整份补丁都会被拒绝；重试时仍要再次提交完整补丁。
- 一个范围较大的补丁可以修改或删除多个文件；范围较大时应审查原始补丁和结果
  差异。

项目仍处于 1.0 之前。兼容目标是声明的 DSH `0.1.x` 范围；发布验收会把安装包
装入干净的 Profile。

## 实现说明

Codex 对齐、失败原子性、换行处理、包入口以及模型服务传输的详细说明见
[实现说明](docs/implementation.zh.md)。

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

`Move to` 可以省略；`End of File` 会把修改片段定位到文件末尾；只有新增行的
更新片段会追加到文件末尾。相对路径从当前会话的工作目录解析；DSH 当前沙箱允许
时，也可以使用绝对路径和父级相对路径。同一文件可以在补丁中出现多次，工具会按
先后顺序处理。`Add File` 指向已有文件时会替换该文件，与 Codex 行为一致。

## 配置

Profile 中的默认配置：

```yaml
- id: tool-apply-patch
  config:
    replaceNativeEdit: true
```

只有在明确希望把 `edit`、`write` 和 `str_replace_editor` 与 `apply_patch`
同时提供给模型时，才设置 `replaceNativeEdit: false`。这个选项不影响自由格式
传输和事务行为。

## 基准测试

第一组 A/B 对比计划使用 DeepSeek V4 Flash，在同一批编码任务上测试 DSH 原生
`edit` 和 DSH Smarter Edit。两组必须使用相同的提示词、模型配置、推理强度、
沙箱、干净的工作区快照和测试次数。

| 指标 | 定义 |
| --- | --- |
| 编辑调用次数 | 完成任务前调用文件编辑工具的总次数 |
| 编辑失败率 | 被拒绝或失败的编辑调用数 / 编辑调用总数 |
| 输出 token | 完整任务中的模型输出 token |
| 交互轮次 | 最终回答前的模型请求次数 |
| 首次测试通过 | 第一次运行测试的退出码为 0 |
| 最终成功 | 编码任务的所有验收检查通过 |
| 总耗时 | 从接受用户请求到给出最终结果的时间 |

如果记录中发送给模型服务的请求把 `apply_patch` 描述为 `type: "function"`，
该次测试不能计入自由格式组。有效测试必须是 OpenAI `type: "custom"` 且
`format.syntax: "lark"`。只有完成多次受控试验后，才把实测结果写入 README。

## 开发

```sh
pnpm install --frozen-lockfile
pnpm peers check
pnpm run check
```

测试覆盖 Codex 官方场景、解析与匹配、沙箱路径、预演隔离、故障回滚、清理、
并发修改检测、工具注册、原生工具过滤、包结构、DSH 原始调用还原、原生差异展示
和 OpenAI 请求序列化。

修改行为或打包前，请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 安全与社区

- 通过 [SECURITY.md](SECURITY.md) 私下报告安全问题。
- 通过 [SUPPORT.md](SUPPORT.md) 获取使用帮助。
- 按 [CONTRIBUTING.md](CONTRIBUTING.md) 和
  [GitHub Issues](https://github.com/Anionex/dsh-smarter-edit/issues) 提交修改建议。
- 在 [CHANGELOG.md](CHANGELOG.md) 查看版本历史。
- 社区参与遵循 [Code of Conduct](CODE_OF_CONDUCT.md)。

由 [Anionex](https://github.com/Anionex) 维护，采用
[MIT License](LICENSE)。
