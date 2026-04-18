import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline/promises";

import { Type } from "@sinclair/typebox";
import type { Static, TextContent } from "@mariozechner/pi-ai";
import { Agent } from "@mariozechner/pi-agent-core";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import YAML from "yaml";

import {
  addMemoryEntry,
  formatUsageSummary,
  removeMemoryEntry,
  replaceMemoryEntry,
  type MemoryMutationResult,
  type MemoryTarget,
} from "./memory.js";

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

export interface DelegationContext {
  preferences: string[];
  activeSkills: string[];
  recentConversation: string[];
}

export type ExecutionLanguage = "shell" | "javascript" | "typescript";
export type ConfirmExecution = (language: ExecutionLanguage, code: string) => Promise<boolean>;
export type CreateCoderAgent = () => Agent;
export type GetDelegationContext = () => DelegationContext;

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

const MemoryParams = Type.Object({
  action: Type.Union([
    Type.Literal("add"),
    Type.Literal("replace"),
    Type.Literal("remove"),
  ], { description: "Memory mutation to perform" }),
  target: Type.Union([
    Type.Literal("memory"),
    Type.Literal("user"),
  ], { description: "Which memory file to update" }),
  content: Type.Optional(Type.String({ description: "New entry content for add/replace" })),
  old_text: Type.Optional(Type.String({ description: "Text used to find an existing entry for replace/remove" })),
});

// ═══════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════

interface ExecuteCodeOptions {
  requireConfirm?: boolean;
  confirmExecution?: ConfirmExecution;
}

interface ToolUpdateSender {
  (update: { content: TextContent[]; details: Record<string, unknown> }): void;
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

function emitToolTextUpdate(
  onUpdate: ToolUpdateSender | undefined,
  text: string,
  details: Record<string, unknown> = {},
): void {
  if (!onUpdate || !text) return;
  onUpdate({ content: [textContent(text)], details });
}

// ═══════════════════════════════════════════════
// Code Execution
// ═══════════════════════════════════════════════

async function runProcess(
  command: string,
  args: string[],
  options: {
    code: string;
    cwd: string;
    language: ExecutionLanguage;
    onUpdate?: ToolUpdateSender;
    shell?: string | boolean;
    signal?: AbortSignal;
  },
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: process.env,
      shell: options.shell,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let output = "";
    let settled = false;
    let timeoutHandle: NodeJS.Timeout | undefined;

    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      options.signal?.removeEventListener("abort", abortHandler);
      callback();
    };

    const appendChunk = (chunk: string, stream: "stdout" | "stderr") => {
      if (!chunk) return;
      output += chunk;
      emitToolTextUpdate(options.onUpdate, chunk, {
        language: options.language,
        stream,
      });
    };

    const abortHandler = () => {
      child.kill("SIGTERM");
      finish(() => reject(new Error("Execution aborted.")));
    };

    timeoutHandle = setTimeout(() => {
      child.kill("SIGTERM");
      finish(() => reject(new Error("Execution timed out after 30 seconds.")));
    }, 30_000);

    options.signal?.addEventListener("abort", abortHandler, { once: true });

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => appendChunk(chunk, "stdout"));
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => appendChunk(chunk, "stderr"));

    child.on("error", (error) => {
      finish(() => reject(error));
    });

    child.on("close", (code, signal) => {
      finish(() => {
        const normalizedOutput = output.trimEnd();
        if (code === 0) {
          resolve(normalizedOutput || "(no output)");
          return;
        }

        reject(
          new Error(
            normalizedOutput || `Process exited with code ${code ?? "unknown"}${signal ? ` (signal: ${signal})` : ""}`,
          ),
        );
      });
    });
  });
}

async function runShell(
  code: string,
  signal?: AbortSignal,
  onUpdate?: ToolUpdateSender,
): Promise<string> {
  return runProcess(code, [], {
    code,
    cwd: process.cwd(),
    language: "shell",
    onUpdate,
    shell: process.env.SHELL || true,
    signal,
  });
}

async function runScript(
  language: Exclude<ExecutionLanguage, "shell">,
  code: string,
  signal?: AbortSignal,
  onUpdate?: ToolUpdateSender,
): Promise<string> {
  const extension = language === "typescript" ? "ts" : "js";
  const tempFile = path.join(os.tmpdir(), `woniu-code-${Date.now()}-${Math.random().toString(36).slice(2)}.${extension}`);

  fs.writeFileSync(tempFile, code, "utf8");

  try {
    return await runProcess("npx", ["tsx", tempFile], {
      code,
      cwd: process.cwd(),
      language,
      onUpdate,
      signal,
    });
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
    execute: async (_toolCallId, params, signal, onUpdate) => {
      if (requireConfirm) {
        const approved = await confirmExecution(params.language, params.code);
        if (!approved) {
          return toToolResult("User cancelled execution.", { cancelled: true });
        }
      }

      const output = params.language === "shell"
        ? await runShell(params.code, signal, onUpdate)
        : await runScript(params.language, params.code, signal, onUpdate);

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
// Tool: memory
// ═══════════════════════════════════════════════

function formatMemoryResult(action: string, result: MemoryMutationResult): string {
  const title = result.target === "memory" ? "MEMORY.md" : "USER.md";
  const lines = [
    result.changed
      ? `${title} updated via ${action}.`
      : `${title} already contained that entry. No change made.`,
    `Usage: ${formatUsageSummary(result.usage)}`,
  ];

  if (result.entries.length === 0) {
    lines.push("Entries: (empty)");
  } else {
    lines.push("Entries:");
    for (const [index, entry] of result.entries.entries()) {
      lines.push(`${index + 1}. ${entry}`);
    }
  }

  lines.push("Changes are saved to disk and will be loaded on the next session start.");
  return lines.join("\n");
}

export function makeMemoryTool(): AgentTool<typeof MemoryParams, Record<string, unknown>> {
  return {
    name: "memory",
    label: "Memory",
    description: "Persist concise long-term facts about the user or environment to MEMORY.md or USER.md.",
    parameters: MemoryParams,
    execute: async (_toolCallId, params) => {
      let result: MemoryMutationResult;
      const target = params.target as MemoryTarget;

      switch (params.action) {
        case "add":
          if (!params.content?.trim()) {
            throw new Error("memory add requires non-empty content.");
          }
          result = addMemoryEntry(target, params.content);
          break;
        case "replace":
          if (!params.old_text?.trim()) {
            throw new Error("memory replace requires old_text.");
          }
          if (!params.content?.trim()) {
            throw new Error("memory replace requires non-empty content.");
          }
          result = replaceMemoryEntry(target, params.old_text, params.content);
          break;
        case "remove":
          if (!params.old_text?.trim()) {
            throw new Error("memory remove requires old_text.");
          }
          result = removeMemoryEntry(target, params.old_text);
          break;
        default:
          throw new Error(`Unsupported memory action: ${params.action}`);
      }

      return toToolResult(formatMemoryResult(params.action, result), {
        action: params.action,
        changed: result.changed,
        entries: result.entries,
        filePath: result.filePath,
        target: result.target,
        usage: result.usage,
      });
    },
  };
}

// ═══════════════════════════════════════════════
// Tool: delegate_to_coder
// ═══════════════════════════════════════════════

function buildDelegationPrompt(task: string, context: DelegationContext): string {
  const sections = [`Task:\n${task.trim()}`];

  if (context.preferences.length > 0) {
    sections.push(`User preferences:\n- ${context.preferences.join("\n- ")}`);
  }

  if (context.activeSkills.length > 0) {
    sections.push(`Active skills:\n- ${context.activeSkills.join("\n- ")}`);
  }

  if (context.recentConversation.length > 0) {
    sections.push(`Recent conversation:\n${context.recentConversation.join("\n")}`);
  }

  sections.push("Complete the task using the context above. Preserve the user's preferences in your final answer.");
  return sections.join("\n\n");
}

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

export function makeDelegateToCoderTool(
  createCoderAgent: CreateCoderAgent,
  getDelegationContext: GetDelegationContext,
): AgentTool<typeof DelegateToCoderParams, Record<string, unknown>> {
  return {
    name: "delegate_to_coder",
    label: "Delegate to Coder",
    description: "Delegate a multi-step programming task to the dedicated coder agent.",
    parameters: DelegateToCoderParams,
    execute: async (_toolCallId, params) => {
      const coder = createCoderAgent();
      const context = getDelegationContext();
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
        await coder.prompt(buildDelegationPrompt(params.task, context));
        await coder.waitForIdle();
      } finally {
        unsubscribe();
        process.stdout.write(`\n${dim}  └──────────────────────────────${reset}\n\n`);
      }

      const result = transcript || extractAssistantText(coder) || "(Coder Agent returned no output)";
      return toToolResult(result, { delegated: true, context });
    },
  };
}

export type ExecuteCodeToolParams = Static<typeof ExecuteCodeParams>;
