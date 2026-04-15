# 当前项目能力测试说明

本文档用于验证当前 `woniu-code` 项目是否满足“最简 Agent CLI Demo”的目标。

测试范围覆盖以下 5 项能力：

1. 终端多轮对话
2. 自定义调用 Skills
3. 执行代码并返回结果
4. 多 Agent 架构
5. 上下文记忆

## 测试目标

验证当前项目已经具备：

- 可启动的 CLI 交互能力
- 可用的 skill 发现和调用能力
- 可控的代码执行能力
- Orchestrator 和 Coder Agent 的最小协作能力
- 会话内上下文保留能力

## 测试前准备

安装依赖：

```bash
npm install
```

推荐先跑类型检查：

```bash
npm run typecheck
```

配置模型环境变量。示例：

```bash
export WONIU_PROVIDER=deepseek
export WONIU_BASE_URL=https://api.deepseek.com/v1
export WONIU_MODEL=deepseek-chat
export WONIU_API_KEY=sk-xxx
```

启动 CLI：

```bash
npm start
```

如果需要关闭执行确认，便于演示代码执行链路：

```bash
npm start -- --yolo
```

## 验收标准

通过本测试，至少应满足以下结果：

- CLI 可以正常启动、接收输入并退出
- 输入 `/` 可以看到内置 slash commands 和已发现的 skills
- `/skill:translator ...` 可以正常工作
- Agent 可以请求执行代码，并在确认后返回输出结果
- 复杂编程任务可以触发 `delegate_to_coder`
- 同一会话内的用户偏好可以影响后续回答

## 测试用例

### 用例 1：CLI 启动与退出

目的：
验证程序可以启动并进入交互循环。

步骤：

```text
1. 执行 npm start
2. 观察是否出现 Banner、Provider、Model 信息
3. 输入 /exit
```

预期结果：

- 终端显示 `Woniu Code v0.1.0`
- 出现输入提示
- 输入 `/exit` 后程序正常退出

补充验证：

```text
1. 启动 CLI
2. 连按两次 Ctrl+C
```

预期结果：

- 第一次按下时，终端提示“再按一次强制退出”
- 第二次按下时，CLI 立即退出

### 用例 2：Slash Command 与 Skill 发现

目的：
验证 slash command 列表和 skill 扫描机制。

步骤：

```text
1. 启动 CLI
2. 输入 /
3. 观察输出内容
4. 输入 /skills translator
```

预期结果：

- 可以看到 `/help`、`/skills`、`/skill`
- 可以看到 `/skill:translator`
- `/skills translator` 会返回包含 translator 的匹配结果

### 用例 3：用户主动调用 Skill

目的：
验证用户可以通过 slash command 主动加载 skill。

步骤：

```text
/skill:translator "Code is read much more often than it is written"
```

预期结果：

- Agent 输出翻译结果
- 输出内容符合 translator skill 的作用
- 不需要用户手工复制 skill 内容

### 用例 4：执行代码并返回结果

目的：
验证 `execute_code` 能运行代码并把结果返回给用户。

建议输入：

```text
帮我写一个 JavaScript 版本的斐波那契函数，并执行输出前 10 个数
```

预期结果：

- Agent 先展示将要执行的代码
- 终端出现 `Execute? [Y/n]`
- 输入 `Y` 后执行成功
- 返回前 10 个斐波那契数的结果

补充验证：

```text
帮我执行 shell 命令 pwd，并告诉我当前目录
```

预期结果：

- Agent 请求执行 shell
- 确认后返回当前工作目录

### 用例 5：多轮对话

目的：
验证同一会话中可以连续交互，后续任务基于前一轮继续。

步骤：

```text
1. 帮我写一个 JavaScript 的斐波那契函数
2. 改成递归版本
3. 再补一个简单注释
```

预期结果：

- 第二轮不需要重复说明“斐波那契函数”
- 第三轮不需要重复说明“递归版本”
- Agent 能沿着上一轮结果继续修改

### 用例 6：上下文偏好记忆

目的：
验证会话内用户偏好可在后续轮次生效。

步骤：

```text
1. 后续输出简洁一点
2. 帮我总结一下快速排序的核心思路
```

预期结果：

- 第二轮回答明显更短
- 回答风格遵循“简洁一点”

补充验证：

```text
1. 请用英文回答
2. Explain what a closure is in JavaScript
```

预期结果：

- 第二轮优先使用英文回答

### 用例 7：多 Agent 协作

目的：
验证 Orchestrator 可以把复杂编码任务委派给 Coder Agent。

建议输入：

```text
写一个快排，然后交给 coder agent 完成，并执行一个简单示例
```

预期结果：

- 终端出现 Coder Agent 的流式输出区域
- 可以看到与 coder 相关的工具执行提示
- 最终返回快排代码或运行结果

### 用例 8：动态发现新 Skill

目的：
验证当前会话可以重新扫描磁盘上的新 skill。

步骤：

1. 在项目内新建文件 `skills/summarizer/SKILL.md`
2. 写入以下内容：

```markdown
---
name: summarizer
description: 压缩总结长文本
---

你是一位擅长压缩长文本的总结专家。输出要短、清晰、保留重点。
```

3. 保持 CLI 不退出
4. 在 CLI 中输入 `/`
5. 再输入：

```text
/skill:summarizer 这是一段需要被压缩总结的长文本……
```

预期结果：

- 不重启 CLI 也能发现 `/skill:summarizer`
- 新 skill 可以直接使用

## 建议录屏 Demo

建议准备两条固定 demo，便于录屏或现场展示。

### Demo 1：Skill + 多轮上下文

操作脚本：

```text
/skill:translator "Code is read much more often than it is written"
后续输出简洁一点
再翻译一句：Simple code is easier to maintain.
```

建议展示点：

- slash command 可用
- skill 可直接调用
- 后续轮次能继承“输出简洁一点”的偏好

### Demo 2：执行代码 + 多 Agent

操作脚本：

```text
帮我写一个 JavaScript 的快排，并执行 [5,3,8,1,2]
改成让 coder agent 完成
```

建议展示点：

- Agent 能请求执行代码
- 执行前需要确认
- 可以触发 coder delegation
- 子 Agent 输出会回到当前终端

## 已知边界

当前文档测试的是“最简可运行 demo”，不是完整产品级验收。

当前边界包括：

- 主要依赖真实模型能力，结果会随模型不同略有波动
- 上下文记忆是会话内记忆，不是跨会话持久化记忆
- 自动补全主要在 TTY/TUI 模式下体验更完整
- `execute_code` 当前偏向演示可用性，尚未建立更严格的安全沙箱
- `--yolo` 只会跳过执行确认，不会新增额外工具能力

## 测试结论模板

可按以下模板记录结果：

```text
日期：
测试人：
模型配置：

用例 1：通过 / 不通过
用例 2：通过 / 不通过
用例 3：通过 / 不通过
用例 4：通过 / 不通过
用例 5：通过 / 不通过
用例 6：通过 / 不通过
用例 7：通过 / 不通过
用例 8：通过 / 不通过

问题记录：
1.
2.
3.
```
