import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline/promises";

import { Type } from "@sinclair/typebox";
import type { Static, TextContent } from "@mariozechner/pi-ai";
import { Agent } from "@mariozechner/pi-agent-core";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import YAML from "yaml";

// ═══════════════════════════════════════════════
// Shared Types
// ═══════════════════════════════════════════════

export interface SkillRecord {
  name: string;
  description: string;
  source: "project" | "user";
  filePath: string;
  baseDir: string;
}

export type ExecutionLanguage = "shell" | "javascript" | "typescript";
export type ConfirmExecution = (language: ExecutionLanguage, code: string) => Promise<boolean>;
export type CreateCoderAgent = () => Agent;

// ═══════════════════════════════════════════════
// SKILL.md Frontmatter Parser
// ═══════════════════════════════════════════════

/**
 * Parse YAML frontmatter from a SKILL.md file.
 * Format: --- \n yaml \n --- \n body
 */
export function parseFrontmatter(content: string): { meta: Record<string, unknown>; body: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { meta: {}, body: content.trim() };

  try {
    const meta = (YAML.parse(match[1]) as Record<string, unknown>) ?? {};
    return { meta, body: match[2].trim() };
  } catch {
    return { meta: {}, body: content.trim() };
  }
}

// ═══════════════════════════════════════════════
// Tool Parameter Schemas
// ═══════════════════════════════════════════════

const ExecuteCodeParams = Type.Object({
  language: Type.Union([
    Type.Literal("shell"),
    Type.Literal("javascript"),
    Type.Literal("typescript"),
  ], { description: "Code language" }),
  code: Type.String({ description: "Code to execute" }),
});

const LoadSkillParams = Type.Object({
  name: Type.String({ description: "Skill name to load" }),
});

const DelegateToCoderParams = Type.Object({
  task: Type.String({ description: "Programming task to delegate" }),
});

// ═══════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════

interface ExecuteCodeOptions {
  requireConfirm?: boolean;
  confirmExecution?: ConfirmExecution;
}

function textContent(text: string): TextContent {
  return { type: "text", text };
}

function toToolResult(content: string, details: Record<string, unknown> = {}) {
  return { content: [textContent(content)], details };
}

function trimOutput(output: string, maxLength = 4096): string {
  if (output.length <= maxLength) return output;
  return `${output.slice(0, maxLength)}\n...(truncated)`;
}

function formatCombinedOutput(stdout: string, stderr: string): string {
  const pieces = [stdout.trimEnd(), stderr.trimEnd()].filter(Boolean);
  return pieces.join("\n");
}

// ═══════════════════════════════════════════════
// Code Execution
// ═══════════════════════════════════════════════

function runShell(code: string): string {
  const result = spawnSync(code, {
    cwd: process.cwd(),
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    shell: process.env.SHELL || true,
    timeout: 30_000,
  });

  if (result.error) throw result.error;

  const output = formatCombinedOutput(result.stdout ?? "", result.stderr ?? "");
  if (result.status !== 0) {
    throw new Error(output || `Shell command exited with code ${result.status ?? "unknown"}`);
  }

  return output || "(no output)";
}

function runScript(language: Exclude<ExecutionLanguage, "shell">, code: string): string {
  const extension = language === "typescript" ? "ts" : "js";
  const tempFile = path.join(os.tmpdir(), `woniu-code-${Date.now()}-${Math.random().toString(36).slice(2)}.${extension}`);

  fs.writeFileSync(tempFile, code, "utf8");

  try {
    const result = spawnSync("npx", ["tsx", tempFile], {
      cwd: process.cwd(),
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      timeout: 30_000,
    });

    if (result.error) throw result.error;

    const output = formatCombinedOutput(result.stdout ?? "", result.stderr ?? "");
    if (result.status !== 0) {
      throw new Error(output || `Script exited with code ${result.status ?? "unknown"}`);
    }

    return output || "(no output)";
  } finally {
    fs.rmSync(tempFile, { force: true });
  }
}

async function defaultConfirmExecution(language: ExecutionLanguage, code: string): Promise<boolean> {
  const dim = "\x1b[2m";
  const cyan = "\x1b[36m";
  const yellow = "\x1b[33m";
  const reset = "\x1b[0m";

  process.stdout.write(`\n${dim}┌─ Code (${language}) ───────────────${reset}\n`);
  process.stdout.write(`${cyan}${code}${reset}\n`);
  process.stdout.write(`${dim}└──────────────────────────────${reset}\n`);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  try {
    const answer = await rl.question(`${yellow}  Execute? [Y/n] ${reset}`);
    return answer.trim().toLowerCase() !== "n";
  } finally {
    rl.close();
  }
}

// ═══════════════════════════════════════════════
// Tool: execute_code
// ═══════════════════════════════════════════════

export function makeExecuteCodeTool(options: ExecuteCodeOptions = {}): AgentTool<typeof ExecuteCodeParams, Record<string, unknown>> {
  const requireConfirm = options.requireConfirm ?? true;
  const confirmExecution = options.confirmExecution ?? defaultConfirmExecution;

  return {
    name: "execute_code",
    label: "Execute Code",
    description: "Execute shell commands or JavaScript/TypeScript and return the output.",
    parameters: ExecuteCodeParams,
    execute: async (_toolCallId, params) => {
      if (requireConfirm) {
        const approved = await confirmExecution(params.language, params.code);
        if (!approved) {
          return toToolResult("User cancelled execution.", { cancelled: true });
        }
      }

      const output = params.language === "shell"
        ? runShell(params.code)
        : runScript(params.language, params.code);

      return toToolResult(trimOutput(output), { language: params.language });
    },
  };
}

// ═══════════════════════════════════════════════
// Tool: load_skill
// ═══════════════════════════════════════════════

export function makeLoadSkillTool(skills: SkillRecord[]): AgentTool<typeof LoadSkillParams, Record<string, unknown>> {
  return {
    name: "load_skill",
    label: "Load Skill",
    description: "Load the full prompt of a named skill (SKILL.md).",
    parameters: LoadSkillParams,
    execute: async (_toolCallId, params) => {
      const skill = skills.find((s) => s.name === params.name);

      if (!skill) {
        const available = skills.map((s) => s.name).join(", ");
        throw new Error(`Skill "${params.name}" not found. Available: ${available || "(none)"}`);
      }

      const content = fs.readFileSync(skill.filePath, "utf8");
      const { meta, body } = parseFrontmatter(content);

      if (!body) {
        throw new Error(`Skill "${skill.name}" has no content.`);
      }

      const description = (meta.description as string)?.trim();
      const blocks = [
        `<skill name="${skill.name}">`,
        description ? `description: ${description}` : "",
        body,
        "</skill>",
      ].filter(Boolean);

      return toToolResult(blocks.join("\n"), { filePath: skill.filePath });
    },
  };
}

// ═══════════════════════════════════════════════
// Tool: delegate_to_coder
// ═══════════════════════════════════════════════

function extractAssistantText(agent: Agent): string {
  for (let index = agent.state.messages.length - 1; index >= 0; index -= 1) {
    const message = agent.state.messages[index];
    if (message.role !== "assistant") continue;

    const text = message.content
      .filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
      .map((block) => block.text)
      .join("");

    if (text) return text;
  }

  return "";
}

export function makeDelegateToCoderTool(createCoderAgent: CreateCoderAgent): AgentTool<typeof DelegateToCoderParams, Record<string, unknown>> {
  return {
    name: "delegate_to_coder",
    label: "Delegate to Coder",
    description: "Delegate a multi-step programming task to the dedicated coder agent.",
    parameters: DelegateToCoderParams,
    execute: async (_toolCallId, params) => {
      const coder = createCoderAgent();
      const dim = "\x1b[2m";
      const purple = "\x1b[38;5;141m";
      const reset = "\x1b[0m";
      let transcript = "";

      process.stdout.write(`\n${dim}  ┌─ 🤖 Coder Agent ──────────────${reset}\n`);

      const unsubscribe = coder.subscribe((event) => {
        switch (event.type) {
          case "message_update":
            if (event.assistantMessageEvent.type === "text_delta") {
              process.stdout.write(`${purple}${event.assistantMessageEvent.delta}${reset}`);
              transcript += event.assistantMessageEvent.delta;
            }
            break;
          case "tool_execution_start":
            process.stdout.write(`\n${dim}    ⚙ [Coder] ${event.toolName}...${reset}\n`);
            break;
          case "tool_execution_end":
            if (event.isError) {
              process.stdout.write(`${dim}    ✗ [Coder] failed${reset}\n`);
            }
            break;
          default:
            break;
        }
      });

      try {
        await coder.prompt(params.task);
        await coder.waitForIdle();
      } finally {
        unsubscribe();
        process.stdout.write(`\n${dim}  └──────────────────────────────${reset}\n\n`);
      }

      const result = transcript || extractAssistantText(coder) || "(Coder Agent returned no output)";
      return toToolResult(result, { delegated: true });
    },
  };
}

export type ExecuteCodeToolParams = Static<typeof ExecuteCodeParams>;
