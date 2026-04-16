# 当前项目能力测试

用于快速验证 `woniu-code` 是否满足当前 Demo 目标。

## 测试范围

1. 多轮对话
2. Skill 调用
3. 执行代码
4. 多 Agent
5. 上下文记忆

## 前置准备

```bash
pnpm install
pnpm run typecheck

export WONIU_PROVIDER=deepseek
export WONIU_BASE_URL=https://api.deepseek.com/v1
export WONIU_MODEL=deepseek-chat
export WONIU_API_KEY=sk-xxx
```

启动：

```bash
pnpm start
```

如果要跳过执行确认：

```bash
pnpm start -- --yolo
```

## 快速验收

### 1. 启动与退出

输入：

```text
/exit
```

预期：

- CLI 正常启动
- 输入 `/exit` 后正常退出
- 连按两次 `Ctrl+C` 可以强制退出

### 2. Slash Command 与 Skill

输入：

```text
/
/skills translator
/skill:translator "Code is read much more often than it is written"
```

预期：

- `/` 能看到内置命令和已发现的 skills
- 能看到 `/skill:translator`
- translator 能正常输出翻译结果

### 3. 执行代码

输入：

```text
帮我写一个 JavaScript 版本的斐波那契函数，并执行前 10 个数
```

预期：

- Agent 会调用 `execute_code`
- 非 `--yolo` 模式下会先请求确认
- 返回执行结果

### 4. 多轮对话

输入：

```text
帮我写一个 JavaScript 的斐波那契函数
改成递归版本
再补一个简单注释
```

预期：

- 后续轮次能延续上一轮上下文

### 5. 上下文偏好

输入：

```text
后续输出简洁一点
帮我总结一下快速排序的核心思路
```

预期：

- 第二轮回答明显更短

### 6. 多 Agent

输入：

```text
写一个快排，然后交给 coder agent 完成，并执行一个简单示例
```

预期：

- 出现 Coder Agent 输出
- 最终返回代码或运行结果

### 7. 动态发现新 Skill

新建：

`skills/summarizer/SKILL.md`

```markdown
---
name: summarizer
description: 压缩总结长文本
---

你是一位擅长压缩长文本的总结专家。输出要短、清晰、保留重点。
```

然后输入：

```text
/
/skill:summarizer 这是一段需要被压缩总结的长文本……
```

预期：

- 当前会话无需重启即可发现新 skill

## Demo 脚本

### Demo 1

```text
/skill:translator "Code is read much more often than it is written"
后续输出简洁一点
再翻译一句：Simple code is easier to maintain.
```

### Demo 2

```text
帮我写一个 JavaScript 的快排，并执行 [5,3,8,1,2]
改成让 coder agent 完成
```

## 记录模板

```text
日期：
测试人：
模型配置：

启动与退出：通过 / 不通过
Skill：通过 / 不通过
执行代码：通过 / 不通过
多轮对话：通过 / 不通过
上下文偏好：通过 / 不通过
多 Agent：通过 / 不通过
动态 Skill 发现：通过 / 不通过

问题：
1.
2.
3.
```
