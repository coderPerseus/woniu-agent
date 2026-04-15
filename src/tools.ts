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

export type ExecutionLanguage = "shell" | "javascript" | "typescript";
export type ConfirmExecution = (language: ExecutionLanguage, code: string) => Promise<boolean>;
export type CreateCoderAgent = () => Agent;

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

interface ExecuteCodeOptions {
  requireConfirm?: boolean;
  confirmExecution?: ConfirmExecution;
}

function textContent(text: string): TextContent {
  return { type: "text", text };
}

function toToolResult(content: string, details: Record<string, unknown> = {}) {
  return {
    content: [textContent(content)],
    details,
  };
}

function trimOutput(output: string, maxLength = 4096): string {
  if (output.length <= maxLength) return output;
  return `${output.slice(0, maxLength)}\n...(truncated)`;
}

function formatCombinedOutput(stdout: string, stderr: string): string {
  const pieces = [stdout.trimEnd(), stderr.trimEnd()].filter(Boolean);
  return pieces.join("\n");
}

function runShell(code: string): string {
  const result = spawnSync(code, {
    cwd: process.cwd(),
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    shell: true,
    timeout: 30_000,
  });

  if (result.error) {
    throw result.error;
  }

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

    if (result.error) {
      throw result.error;
    }

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

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const answer = await rl.question(`${yellow}  Execute? [Y/n] ${reset}`);
    return answer.trim().toLowerCase() !== "n";
  } finally {
    rl.close();
  }
}

export async function askConfirmation(question: string): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const answer = await rl.question(question);
    return answer.trim().toLowerCase() !== "n";
  } finally {
    rl.close();
  }
}

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

function listAvailableSkills(skillDirs: string[]): string[] {
  const names = new Set<string>();

  for (const dir of skillDirs) {
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir)) {
      if (entry.endsWith(".yaml")) names.add(entry.replace(/\.yaml$/, ""));
    }
  }

  return [...names].sort();
}

export function makeLoadSkillTool(skillDirs: string[]): AgentTool<typeof LoadSkillParams, Record<string, unknown>> {
  return {
    name: "load_skill",
    label: "Load Skill",
    description: "Load the full prompt of a named skill from project or user skill directories.",
    parameters: LoadSkillParams,
    execute: async (_toolCallId, params) => {
      for (const dir of skillDirs) {
        const filePath = path.join(dir, `${params.name}.yaml`);
        if (!fs.existsSync(filePath)) continue;

        const raw = fs.readFileSync(filePath, "utf8");
        const parsed = YAML.parse(raw) as { name?: string; description?: string; prompt?: string } | null;
        const skillName = parsed?.name ?? params.name;
        const prompt = parsed?.prompt?.trim();
        const description = parsed?.description?.trim();

        if (!prompt) {
          throw new Error(`Skill "${skillName}" is missing a prompt.`);
        }

        const blocks = [
          `<skill name="${skillName}">`,
          description ? `description: ${description}` : "",
          prompt,
          "</skill>",
        ].filter(Boolean);

        return toToolResult(blocks.join("\n"), { filePath });
      }

      const available = listAvailableSkills(skillDirs);
      throw new Error(`Skill "${params.name}" not found. Available: ${available.join(", ") || "(none)"}`);
    },
  };
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
