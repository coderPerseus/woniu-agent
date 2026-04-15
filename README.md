# Woniu Code

`woniu-code` 是一个最小可运行的多 Agent CLI Demo，基于 `pi-ai` 和 `pi-agent-core` 构建。

它提供三类核心能力：

- `execute_code`: 执行 shell、JavaScript、TypeScript，主 Agent 执行前会请求确认
- `load_skill`: 从 SKILL.md 加载技能 Prompt（LLM 自动决定）
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
| `WONIU_API_KEY` | 通常需要 | - | Provider API key |
| `WONIU_PROVIDER` | 否 | `anthropic` | Provider 名称 |
| `WONIU_MODEL` | 否 | `claude-sonnet-4-20250514` | 模型 ID |
| `WONIU_BASE_URL` | 否 | - | 自定义 OpenAI 兼容端点 |

示例：

```bash
# Anthropic
export WONIU_API_KEY=sk-ant-xxx

# OpenAI
export WONIU_PROVIDER=openai WONIU_MODEL=gpt-4o WONIU_API_KEY=sk-xxx

# DeepSeek
export WONIU_PROVIDER=deepseek WONIU_BASE_URL=https://api.deepseek.com/v1 WONIU_MODEL=deepseek-chat WONIU_API_KEY=sk-xxx

# Ollama
export WONIU_PROVIDER=ollama WONIU_BASE_URL=http://localhost:11434/v1 WONIU_MODEL=llama3
```

## Skill 系统

### 内置 Skills

当前项目默认内置 11 个 skills：

- 当前项目自带：`translator`、`code-reviewer`
- 来自 [tw93/Waza](https://github.com/tw93/Waza)：`check`、`design`、`health`、`hunt`、`learn`、`read`、`think`、`write`
- 来自 [forrestchang/andrej-karpathy-skills](https://github.com/forrestchang/andrej-karpathy-skills)：`karpathy-guidelines`

这些 skills 都放在项目内的 `skills/` 目录下，因此会优先于用户全局目录中的同名 skill 被发现。

### 格式

Skill 使用 `SKILL.md` 文件（YAML frontmatter + Markdown body），与 pi-mono 兼容：

```
skills/
  my-skill/
    SKILL.md
```

SKILL.md 格式：

```markdown
---
name: my-skill
description: 一句简短说明
---

这里放完整的专家提示词。
```

### 目录扫描

程序按优先级扫描以下目录（同名 skill 先到先得）：

1. `./skills/` — 项目级（woniu-code 自身）
2. `.pi/skills/` — pi-mono 项目级
3. `.agents/skills/` — 当前目录到 git repo root 的祖先目录共享 skills
4. `~/.pi/agent/skills/` — pi-mono 用户级
5. `~/.agents/skills/` — 其他 agent 共享的用户级 skills

发现规则：

- 目录中只要存在 `SKILL.md`，该目录就会被当作一个 skill root
- 会递归扫描子目录寻找 `SKILL.md`
- 普通 `.md` 文件不会被当作 skill，只有 `SKILL.md` 会被识别

### 使用方式

**方式一：`/` 命令（用户主动调用）**

```
❯ /                          # 列出所有可用 skills
❯ /skill:translator 你好     # 加载 translator skill + 发送 "你好"
❯ /skill:code-reviewer       # 仅加载 skill（无额外参数）
❯ /skill:skill-creator       # 如果 ~/.agents/skills 中存在该 skill，会自动出现
```

**方式一补充：`/skill` 自动补全**

- 输入 `/skill` 或 `/skill:前缀` 时，会自动显示匹配的 skills 下拉列表
- `↑/↓` 切换选项
- `Tab` 接受当前补全，自动填入 `/skill:name `
- `Enter` 提交当前输入

**方式二：LLM 自动调用**

Orchestrator 的 system prompt 包含所有 skill 元数据。LLM 可以自主调用 `load_skill` tool 按需加载。

`/` 和 `/skill:name` 每次输入前都会重新扫描磁盘，所以新创建的 skill 在当前会话里也能立刻看到。

## Demo 用法

```text
❯ /
  /skill:check         — ...
  /skill:karpathy-guidelines — ...
  /skill:translator    — 精准翻译文本，保持语气和风格 [project]
  /skill:code-reviewer — 审查代码质量，发现潜在问题 [project]

❯ /skill:check
❯ /skill:karpathy-guidelines
❯ /skill:translator "Code is read much more often than it is written"
❯ 帮我写一个 JavaScript 的斐波那契函数并执行前 10 个数
❯ 改成递归版本
❯ 写一个快排然后帮我 review
```

## 结构

```text
.
├── package.json
├── README.md
├── skills/
│   ├── check/
│   │   └── SKILL.md
│   ├── code-reviewer/
│   │   └── SKILL.md
│   ├── design/
│   │   └── SKILL.md
│   ├── health/
│   │   └── SKILL.md
│   ├── hunt/
│   │   └── SKILL.md
│   ├── karpathy-guidelines/
│   │   └── SKILL.md
│   ├── learn/
│   │   └── SKILL.md
│   ├── read/
│   │   └── SKILL.md
│   ├── think/
│   │   └── SKILL.md
│   ├── translator/
│   │   └── SKILL.md
│   └── write/
│       └── SKILL.md
└── src/
    ├── agents.ts    # Model 解析 + Skill 扫描 + Agent 工厂
    ├── index.ts     # Banner + REPL + Slash 命令
    └── tools.ts     # Tool 定义 + 前置解析器
```
