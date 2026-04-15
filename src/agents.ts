import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { getEnvApiKey, getModel } from "@mariozechner/pi-ai";
import type { KnownProvider, Model } from "@mariozechner/pi-ai";
import { Agent } from "@mariozechner/pi-agent-core";
import YAML from "yaml";

import {
  type ConfirmExecution,
  makeDelegateToCoderTool,
  makeExecuteCodeTool,
  makeLoadSkillTool,
} from "./tools.js";

interface SkillRecord {
  name: string;
  description: string;
  source: "project" | "user";
  filePath: string;
}

interface CreateOrchestratorOptions {
  confirmExecution?: ConfirmExecution;
}

const ORCHESTRATOR_PROMPT = (skillList: string) => `You are Woniu Code, a concise terminal AI assistant.

Capabilities:
1. Answer the user directly.
2. Use execute_code to run shell commands or JavaScript/TypeScript when execution is needed.
3. Use load_skill to load specialist guidance before handling translation, review, or other domain tasks.
4. Use delegate_to_coder only for coding tasks that need multi-step execution.

Available skills:
${skillList}

Behavior rules:
- Keep answers direct and practical.
- Respect the user's requested verbosity.
- Prefer doing the work over describing intent.
- Only delegate when the task is meaningfully complex.
`;

const CODER_PROMPT = `You are the dedicated coder agent for Woniu Code.

Responsibilities:
- Write code needed to solve the delegated task.
- Use execute_code when execution helps verify or produce the result.
- Keep the output concise and oriented around the completed work.

Rules:
- Analyze before executing.
- Prefer small, clear implementations.
- If execution fails, diagnose and retry when the next step is obvious.
`;

function getSkillDirs(): string[] {
  const projectDir = path.join(process.cwd(), "skills");
  const userDir = path.join(os.homedir(), ".woniu", "skills");
  fs.mkdirSync(userDir, { recursive: true });
  return [projectDir, userDir];
}

function loadSkillYaml(filePath: string): { name?: string; description?: string } | null {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return YAML.parse(raw) as { name?: string; description?: string } | null;
  } catch {
    return null;
  }
}

export function scanSkills(): { metadata: string; dirs: string[] } {
  const dirs = getSkillDirs();
  const skills = new Map<string, SkillRecord>();

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    const source: SkillRecord["source"] = dir.includes(`${path.sep}.woniu${path.sep}`) ? "user" : "project";

    for (const entry of fs.readdirSync(dir)) {
      if (!entry.endsWith(".yaml")) continue;

      const filePath = path.join(dir, entry);
      const parsed = loadSkillYaml(filePath);
      const name = parsed?.name?.trim() || entry.replace(/\.yaml$/, "");
      if (skills.has(name)) continue;

      skills.set(name, {
        name,
        description: parsed?.description?.trim() || "No description",
        source,
        filePath,
      });
    }
  }

  const metadata = [...skills.values()]
    .map((skill) => `- ${skill.name}: ${skill.description} [${skill.source}]`)
    .join("\n");

  return {
    metadata: metadata || "(no skills available)",
    dirs,
  };
}

function setProviderApiKey(provider: string, apiKey: string): void {
  const envKeyMap: Record<string, string> = {
    anthropic: "ANTHROPIC_API_KEY",
    openai: "OPENAI_API_KEY",
    groq: "GROQ_API_KEY",
    xai: "XAI_API_KEY",
  };

  const envKey = envKeyMap[provider] ?? "OPENAI_API_KEY";
  process.env[envKey] = apiKey;
}

export function resolveApiKey(provider: string): string | undefined {
  return process.env.WONIU_API_KEY
    || getEnvApiKey(provider as KnownProvider)
    || process.env.OPENAI_API_KEY
    || process.env.ANTHROPIC_API_KEY
    || process.env.GROQ_API_KEY
    || process.env.XAI_API_KEY;
}

export function resolveModel(): Model<any> {
  const provider = process.env.WONIU_PROVIDER ?? "anthropic";
  const modelId = process.env.WONIU_MODEL ?? "claude-sonnet-4-20250514";
  const baseUrl = process.env.WONIU_BASE_URL;
  const apiKey = process.env.WONIU_API_KEY;

  if (apiKey) {
    setProviderApiKey(provider, apiKey);
  }

  if (baseUrl) {
    return {
      id: modelId,
      name: modelId,
      api: "openai-completions",
      provider,
      baseUrl,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 8192,
    };
  }

  try {
    return getModel(provider as KnownProvider, modelId as never);
  } catch {
    console.error(`\x1b[31mError: Cannot find model "${modelId}" for provider "${provider}".\x1b[0m`);
    console.error(`\x1b[31mSet WONIU_BASE_URL to use a custom OpenAI-compatible endpoint.\x1b[0m`);
    process.exit(1);
  }
}

export function createOrchestrator(model: Model<any>, options: CreateOrchestratorOptions = {}): Agent {
  const { metadata, dirs } = scanSkills();

  return new Agent({
    getApiKey: (provider) => resolveApiKey(provider),
    initialState: {
      systemPrompt: ORCHESTRATOR_PROMPT(metadata),
      model,
      tools: [
        makeExecuteCodeTool({
          requireConfirm: true,
          confirmExecution: options.confirmExecution,
        }),
        makeLoadSkillTool(dirs),
        makeDelegateToCoderTool(() => createCoder(model)),
      ],
    },
  });
}

export function createCoder(model: Model<any>): Agent {
  return new Agent({
    getApiKey: (provider) => resolveApiKey(provider),
    initialState: {
      systemPrompt: CODER_PROMPT,
      model,
      tools: [
        makeExecuteCodeTool({ requireConfirm: false }),
      ],
    },
  });
}
