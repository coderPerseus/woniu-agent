# Woniu Code

`woniu-code` 是一个最小可运行的多 Agent CLI Demo，基于 `pi-ai` 和 `pi-agent-core` 构建。

它提供三类核心能力：

- `execute_code`: 执行 shell、JavaScript、TypeScript，主 Agent 执行前会请求确认
- `load_skill`: 从项目级 `./skills` 和用户级 `~/.woniu/skills` 加载技能 Prompt
- `delegate_to_coder`: 将复杂编程任务委派给专用 Coder Agent，并在终端中流式打印其执行过程

## 安装

```bash
npm install
```

## 运行

```bash
npm start
```

开发模式：

```bash
npm run dev
```

类型检查：

```bash
npm run typecheck
```

## 环境变量

| 变量 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `WONIU_API_KEY` | 通常需要 | - | Provider API key，自定义 OpenAI 兼容端点也走这里 |
| `WONIU_PROVIDER` | 否 | `anthropic` | Provider 名称 |
| `WONIU_MODEL` | 否 | `claude-sonnet-4-20250514` | 模型 ID |
| `WONIU_BASE_URL` | 否 | - | 自定义 OpenAI 兼容端点，设置后不走内置 model registry |

示例：

```bash
# Anthropic
export WONIU_API_KEY=sk-ant-xxx

# OpenAI
export WONIU_PROVIDER=openai
export WONIU_MODEL=gpt-4o
export WONIU_API_KEY=sk-xxx

# DeepSeek
export WONIU_PROVIDER=deepseek
export WONIU_BASE_URL=https://api.deepseek.com/v1
export WONIU_MODEL=deepseek-chat
export WONIU_API_KEY=sk-xxx

# Ollama
export WONIU_PROVIDER=ollama
export WONIU_BASE_URL=http://localhost:11434/v1
export WONIU_MODEL=llama3
```

## Skill 目录

- 项目级：`./skills`
- 用户级：`~/.woniu/skills`

同名 skill 由项目级覆盖用户级。程序启动时会自动创建 `~/.woniu/skills`。

示例 skill 文件：

```yaml
name: my-skill
description: 一句简短说明
prompt: |
  这里放完整的专家提示词。
```

## Demo 用法

```text
❯ 帮我写一个 JavaScript 的斐波那契函数并执行前 10 个数
❯ 改成递归版本
❯ 翻译 "Code is read much more often than it is written"
❯ 写一个快排然后帮我 review
```

## 结构

```text
.
├── package.json
├── README.md
├── skills/
│   ├── code-reviewer.yaml
│   └── translator.yaml
└── src/
    ├── agents.ts
    ├── index.ts
    └── tools.ts
```
