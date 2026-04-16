# Woniu Code

`woniu-code` 是一个最小可运行的多 Agent CLI Demo，基于 `pi-ai` 和 `pi-agent-core` 构建。

它提供四类核心能力：

- `execute_code`: 执行 shell、JavaScript、TypeScript，主 Agent 和 Coder Agent 执行前都会请求确认
- `load_skill`: 从 `SKILL.md` 加载技能 Prompt，支持用户主动调用和 LLM 按需调用
- `delegate_to_coder`: 将复杂编程任务委派给专用 Coder Agent，并在终端中流式打印其执行过程
- `context handoff`: 子 Agent 会继承用户偏好、最近几轮对话摘要和当前激活的 skill

运行时有两种交互模式：

- TTY 模式：默认进入彩色 TUI，支持 slash command 自动补全
- 非 TTY 模式：回退到标准 readline REPL，功能保持一致，但没有下拉补全
- 传入 `--yolo`：跳过 `execute_code` 的逐次确认，主 Agent 和 Coder Agent 都会直接执行
- 输入 `/exit`：正常退出 CLI
- 连按两次 `Ctrl+C`：强制退出，无论当前是否正在执行任务

## 安装

```bash
pnpm install
```

## 运行

```bash
# 配置 API 。例如配置 Deepseek
export WONIU_PROVIDER=deepseek
export WONIU_BASE_URL=https://api.deepseek.com/v1
export WONIU_MODEL=deepseek-chat
export WONIU_API_KEY=sk-xxx 

pnpm start
```

如果要关闭执行确认：

```bash
pnpm start -- --yolo
```

开发模式：

```bash
pnpm run dev
```

类型检查：

```bash
pnpm run typecheck
```

## 环境变量

| 变量 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `WONIU_API_KEY` | 通常需要 | - | Provider API key；优先于 provider 自己的环境变量 |
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

当前仓库自带 `translator` 示例 skill。项目目录和兼容的全局目录里新增 `SKILL.md` 后，当前会话里也能马上被发现。

### 目录扫描

程序按优先级扫描以下目录，同名 skill 先到先得：

1. `./skills/`
2. `.pi/skills/`
3. `.agents/skills/`，从当前目录向上找到 git repo root 为止
4. `~/.pi/agent/skills/`
5. `~/.agents/skills/`

发现规则：

- 目录中只要存在 `SKILL.md`，该目录就会被当作一个 skill root
- 会递归扫描子目录寻找 `SKILL.md`
- 普通 `.md` 文件不会被当作 skill，只有 `SKILL.md` 会被识别

### 使用方式

用户主动调用：

```text
❯ /                          # 列出所有 slash commands 和 skills
❯ /skill:translator 你好     # 加载 translator skill + 发送 "你好"
❯ /skills translator         # 按关键字过滤 slash commands / skills
❯ /skill:my-skill            # 如果磁盘上存在该 skill，会自动出现
```

自动补全：

- 仅在 TTY/TUI 模式下可用
- 输入 `/` 时会显示 slash commands 下拉列表，其中包含内置命令和发现到的 skills
- 输入 `/skill` 或 `/skill:前缀` 时，会进一步收敛到匹配的 skill 命令
- `↑/↓` 切换选项
- `Tab` 接受当前补全，自动填入 `/skill:name `
- `Enter` 提交当前输入

LLM 自动调用：

- Orchestrator 的 system prompt 包含所有 skill 元数据
- LLM 可以自主调用 `load_skill` tool 按需加载 skill
- `/` 和 `/skill:name` 每次输入前都会重新扫描磁盘，所以新创建的 skill 在当前会话里也能立刻看到

## Demo 用法

```text
❯ /
  /skill:translator    — 精准翻译文本，保持语气和风格 [project]

❯ /skill:translator "Code is read much more often than it is written"
❯ 后续输出简洁一点
❯ 帮我写一个 JavaScript 的斐波那契函数并执行前 10 个数
  # Agent 会先展示待执行代码，再请求确认
❯ 改成递归版本
❯ 写一个快排然后交给 coder agent 完成
```

## 结构

```text
.
├── package.json
├── README.md
├── skills/
│   └── translator/
│       └── SKILL.md
└── src/
    ├── agents.ts        # Model 解析 + Skill 扫描 + Agent 工厂
    ├── index.ts         # Banner + REPL + Slash 命令
    ├── tui-shell.ts     # TUI 交互层 + slash command 自动补全
    └── tools.ts         # Tool 定义 + SKILL.md 解析
```
