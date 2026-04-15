import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { getEnvApiKey, getModels } from "@mariozechner/pi-ai";
import type { KnownProvider, Model } from "@mariozechner/pi-ai";
import { Agent } from "@mariozechner/pi-agent-core";
import type { AgentMessage } from "@mariozechner/pi-agent-core";

import {
  type ConfirmExecution,
  type DelegationContext,
  type SkillRecord,
  makeDelegateToCoderTool,
  makeExecuteCodeTool,
  makeLoadSkillTool,
  parseFrontmatter,
} from "./tools.js";

// ═══════════════════════════════════════════════
// System Prompts
// ═══════════════════════════════════════════════

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

const PROVIDER_ENV_KEYS: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  groq: "GROQ_API_KEY",
  xai: "XAI_API_KEY",
};

// ═══════════════════════════════════════════════
// Skill Discovery
// ═══════════════════════════════════════════════

/**
 * Scan directories for skills.
 *
 * Precedence (first found wins on name collision):
 *   1. ./skills/                 — woniu project-level
 *   2. .pi/skills/               — pi project-level
 *   3. .agents/skills/           — project/ancestor shared skills
 *   4. ~/.pi/agent/skills/       — pi user-level
 *   5. ~/.agents/skills/         — shared user-level skills
 */
interface SkillDirSpec {
  dir: string;
  source: SkillRecord["source"];
}

function findGitRepoRoot(startDir: string): string | null {
  let dir = path.resolve(startDir);

  while (true) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir;

    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function collectAncestorAgentsSkillDirs(startDir: string): string[] {
  const dirs: string[] = [];
  const gitRepoRoot = findGitRepoRoot(startDir);
  let dir = path.resolve(startDir);

  while (true) {
    dirs.push(path.join(dir, ".agents", "skills"));

    if (gitRepoRoot && dir === gitRepoRoot) break;

    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return dirs;
}

function dedupePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];

  for (const target of paths) {
    const resolved = path.resolve(target);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    deduped.push(resolved);
  }

  return deduped;
}

function getSkillDirs(): SkillDirSpec[] {
  const cwd = process.cwd();
  const homeDir = os.homedir();

  return [
    { dir: path.join(cwd, "skills"), source: "project" },
    { dir: path.join(cwd, ".pi", "skills"), source: "project" },
    ...dedupePaths(collectAncestorAgentsSkillDirs(cwd)).map((dir) => ({
      dir,
      source: "project" as const,
    })),
    { dir: path.join(homeDir, ".pi", "agent", "skills"), source: "user" },
    { dir: path.join(homeDir, ".agents", "skills"), source: "user" },
  ];
}

function scanSkillFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const entry of entries) {
    if (entry.name === "SKILL.md" && entry.isFile()) {
      return [path.join(dir, entry.name)];
    }
  }

  const files: string[] = [];

  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;

    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...scanSkillFiles(fullPath));
      continue;
    }
  }

  return files;
}

function getSkillName(filePath: string, meta: Record<string, unknown>): string {
  const declaredName = typeof meta.name === "string" ? meta.name.trim() : "";
  if (declaredName) return declaredName;

  return path.basename(filePath) === "SKILL.md"
    ? path.basename(path.dirname(filePath))
    : path.basename(filePath, path.extname(filePath));
}

export function scanSkills(): { skills: SkillRecord[] } {
  const dirs = getSkillDirs();
  const skills = new Map<string, SkillRecord>();

  for (const spec of dirs) {
    const filePaths = scanSkillFiles(spec.dir);

    for (const skillMdPath of filePaths) {
      let content: string;
      try {
        content = fs.readFileSync(skillMdPath, "utf8");
      } catch {
        continue;
      }

      const { meta } = parseFrontmatter(content);
      const name = getSkillName(skillMdPath, meta);
      const description = typeof meta.description === "string" ? meta.description.trim() : "";

      if (skills.has(name)) continue;
      if (!description) continue;

      skills.set(name, {
        name,
        description,
        source: spec.source,
        filePath: skillMdPath,
        baseDir: path.dirname(skillMdPath),
      });
    }
  }

  return { skills: [...skills.values()] };
}

// ═══════════════════════════════════════════════
// Slash Commands
// ═══════════════════════════════════════════════

export interface SlashCommandRecord {
  command: string;
  description: string;
  source: "builtin" | SkillRecord["source"];
}

export type ParsedSlashCommand =
  | { kind: "escaped"; text: string }
  | { kind: "exit" }
  | { kind: "list"; query: string }
  | { kind: "run-skill"; skill: SkillRecord; args: string }
  | { kind: "unknown"; command: string; suggestions: SlashCommandRecord[] };

const BUILTIN_SLASH_COMMANDS: ReadonlyArray<Omit<SlashCommandRecord, "source">> = [
  { command: "/exit", description: "Exit the CLI." },
  { command: "/help", description: "Show available slash commands." },
  { command: "/skills", description: "List skills, optionally filtered by a query." },
  { command: "/skill", description: "Run a skill by name: /skill translator text to translate" },
];

function normalizeSlashQuery(value: string): string {
  return value.trim().toLowerCase();
}

function compareSlashCommands(left: SlashCommandRecord, right: SlashCommandRecord): number {
  const leftBuiltin = left.source === "builtin" ? 0 : 1;
  const rightBuiltin = right.source === "builtin" ? 0 : 1;
  if (leftBuiltin !== rightBuiltin) return leftBuiltin - rightBuiltin;
  return left.command.localeCompare(right.command);
}

function scoreSlashCommand(record: SlashCommandRecord, query: string): number {
  if (!query) return 0;

  const normalizedCommand = record.command.toLowerCase();
  const normalizedDescription = record.description.toLowerCase();
  const normalizedQuery = query.toLowerCase();

  if (normalizedCommand === `/${normalizedQuery}`) return 0;
  if (normalizedCommand.startsWith(`/${normalizedQuery}`)) return 1;
  if (normalizedCommand.includes(normalizedQuery)) return 2;
  if (normalizedDescription.includes(normalizedQuery)) return 3;
  return 99;
}

function resolveSkillByName(skills: SkillRecord[], skillName: string): SkillRecord | null {
  const exact = skills.find((skill) => skill.name === skillName);
  if (exact) return exact;

  const normalized = skillName.toLowerCase();
  const insensitive = skills.filter((skill) => skill.name.toLowerCase() === normalized);
  return insensitive.length === 1 ? insensitive[0] : null;
}

export function getSlashCommandRecords(skills: SkillRecord[]): SlashCommandRecord[] {
  const builtin = BUILTIN_SLASH_COMMANDS.map((command) => ({
    ...command,
    source: "builtin" as const,
  }));

  const skillCommands = skills.map((skill) => ({
    command: `/skill:${skill.name}`,
    description: skill.description,
    source: skill.source,
  }));

  return [...builtin, ...skillCommands].sort(compareSlashCommands);
}

export function searchSlashCommands(
  skills: SkillRecord[],
  query: string,
  maxResults = 8,
): SlashCommandRecord[] {
  const normalizedQuery = normalizeSlashQuery(query).replace(/^\//, "");
  const allCommands = getSlashCommandRecords(skills);

  const filtered = normalizedQuery
    ? allCommands.filter((record) => scoreSlashCommand(record, normalizedQuery) < 99)
    : allCommands;

  return filtered
    .sort((left, right) => {
      const scoreDiff = scoreSlashCommand(left, normalizedQuery) - scoreSlashCommand(right, normalizedQuery);
      if (scoreDiff !== 0) return scoreDiff;
      return compareSlashCommands(left, right);
    })
    .slice(0, maxResults);
}

export function parseSlashCommandInput(input: string, skills: SkillRecord[]): ParsedSlashCommand | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return null;

  if (trimmed.startsWith("//")) {
    return { kind: "escaped", text: trimmed.slice(1) };
  }

  if (trimmed === "/exit") {
    return { kind: "exit" };
  }

  if (trimmed === "/" || trimmed === "/help" || trimmed === "/skill" || trimmed === "/skill:") {
    return { kind: "list", query: "" };
  }

  const skillsMatch = trimmed.match(/^\/skills(?:\s+(.+))?$/);
  if (skillsMatch) {
    const query = skillsMatch[1]?.trim() ?? "";
    return { kind: "list", query };
  }

  if (trimmed.startsWith("/skill:")) {
    const payload = trimmed.slice("/skill:".length);
    const separator = payload.search(/\s/);
    const skillName = separator === -1 ? payload : payload.slice(0, separator);
    const args = separator === -1 ? "" : payload.slice(separator).trim();
    const skill = resolveSkillByName(skills, skillName);

    if (skill) {
      return { kind: "run-skill", skill, args };
    }

    return {
      kind: "unknown",
      command: `/skill:${skillName}`,
      suggestions: searchSlashCommands(skills, skillName),
    };
  }

  if (trimmed.startsWith("/skill ")) {
    const payload = trimmed.slice("/skill ".length).trim();
    if (!payload) {
      return { kind: "list", query: "" };
    }

    const separator = payload.search(/\s/);
    const skillName = separator === -1 ? payload : payload.slice(0, separator);
    const args = separator === -1 ? "" : payload.slice(separator).trim();
    const skill = resolveSkillByName(skills, skillName);

    if (skill) {
      return { kind: "run-skill", skill, args };
    }

    return {
      kind: "unknown",
      command: `/skill ${skillName}`,
      suggestions: searchSlashCommands(skills, skillName),
    };
  }

  const command = trimmed.slice(1).split(/\s+/, 1)[0] ?? "";
  return {
    kind: "unknown",
    command: `/${command}`,
    suggestions: searchSlashCommands(skills, command),
  };
}

/**
 * Expand /skill:name [args] into a prompt string.
 *
 * Follows pi-mono's pattern: read SKILL.md, strip frontmatter,
 * wrap body in <skill> tags, append user args.
 */
export function expandSkillCommand(input: string, skills: SkillRecord[]): string | null {
  const parsed = parseSlashCommandInput(input, skills);
  if (!parsed || parsed.kind !== "run-skill") return null;

  const { skill, args } = parsed;

  let content: string;
  try {
    content = fs.readFileSync(skill.filePath, "utf8");
  } catch {
    return null;
  }

  const { body } = parseFrontmatter(content);
  if (!body) return null;

  const block = [
    `<skill name="${skill.name}" location="${skill.filePath}">`,
    `References are relative to ${skill.baseDir}.`,
    "",
    body,
    "</skill>",
  ].join("\n");

  return args ? `${block}\n\n${args}` : block;
}

// ═══════════════════════════════════════════════
// Model & API Key
// ═══════════════════════════════════════════════

function setProviderApiKey(provider: string, apiKey: string): void {
  const envKey = PROVIDER_ENV_KEYS[provider] ?? `${provider.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`;
  process.env[envKey] = apiKey;
}

export function resolveApiKey(provider: string): string | undefined {
  if (process.env.WONIU_API_KEY) return process.env.WONIU_API_KEY;

  const providerKey = getEnvApiKey(provider as KnownProvider);
  if (providerKey) return providerKey;

  const envKey = PROVIDER_ENV_KEYS[provider] ?? `${provider.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`;
  return process.env[envKey];
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

  if (!resolveApiKey(provider) && provider !== "ollama") {
    console.error(`\x1b[31mError: Missing API key for provider "${provider}".\x1b[0m`);
    console.error("\x1b[31mSet WONIU_API_KEY or the provider-specific API key before starting the CLI.\x1b[0m");
    process.exit(1);
  }

  try {
    const knownProvider = provider as KnownProvider;
    const model = getModels(knownProvider).find((entry) => entry.id === modelId);
    if (model) return model;
    throw new Error("Model not found");
  } catch {
    console.error(`\x1b[31mError: Cannot find model "${modelId}" for provider "${provider}".\x1b[0m`);
    console.error(`\x1b[31mSet WONIU_BASE_URL to use a custom OpenAI-compatible endpoint.\x1b[0m`);
    process.exit(1);
  }
}

// ═══════════════════════════════════════════════
// Agent Factories
// ═══════════════════════════════════════════════

interface CreateOrchestratorOptions {
  confirmExecution?: ConfirmExecution;
  requireExecutionConfirm?: boolean;
}

function extractMessageText(message: AgentMessage): string {
  if (!("content" in message)) return "";

  if (typeof message.content === "string") {
    return message.content.trim();
  }

  if (!Array.isArray(message.content)) return "";

  return message.content
    .filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();
}

function summarizeMessageText(text: string, maxLength = 280): string {
  if (!text) return "";

  const normalized = text.replace(/\s+/g, " ").trim();
  const skillMatch = normalized.match(/<skill name="([^"]+)"/);
  if (skillMatch) {
    return `[loaded skill: ${skillMatch[1]}]`;
  }

  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength)}...`;
}

function extractPreferenceHints(messages: AgentMessage[]): string[] {
  const preferences = new Set<string>();

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!("role" in message) || message.role !== "user") continue;

    const text = extractMessageText(message);
    if (!text) continue;

    if (/(后续|以后|之后|接下来).*(简洁|简短|精炼)|输出简洁|concise|brief/i.test(text)) {
      preferences.add("Keep answers concise unless the user asks for more detail.");
    }
    if (/(请用中文|用中文|中文回答|中文输出|reply in chinese)/i.test(text)) {
      preferences.add("Reply in Chinese.");
    }
    if (/(请用英文|用英文|英文回答|英文输出|reply in english)/i.test(text)) {
      preferences.add("Reply in English.");
    }
    if (/(直接一点|直接回答|别废话|don't explain too much)/i.test(text)) {
      preferences.add("Prefer direct answers over long explanations.");
    }
  }

  return [...preferences];
}

function extractActiveSkills(messages: AgentMessage[]): string[] {
  const skills = new Set<string>();

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const text = extractMessageText(messages[index]);
    if (!text) continue;

    for (const match of text.matchAll(/<skill name="([^"]+)"/g)) {
      skills.add(match[1]);
      if (skills.size >= 3) return [...skills];
    }
  }

  return [...skills];
}

function extractRecentConversation(messages: AgentMessage[], maxMessages = 6): string[] {
  const conversation: string[] = [];

  for (let index = messages.length - 1; index >= 0 && conversation.length < maxMessages; index -= 1) {
    const message = messages[index];
    if (!("role" in message)) continue;
    if (message.role !== "user" && message.role !== "assistant") continue;

    const summary = summarizeMessageText(extractMessageText(message));
    if (!summary) continue;
    conversation.push(`${message.role}: ${summary}`);
  }

  return conversation.reverse();
}

function buildDelegationContext(agent: Agent): DelegationContext {
  return {
    preferences: extractPreferenceHints(agent.state.messages),
    activeSkills: extractActiveSkills(agent.state.messages),
    recentConversation: extractRecentConversation(agent.state.messages),
  };
}

function formatSkillMetadata(skills: SkillRecord[]): string {
  return skills.length > 0
    ? skills.map((skill) => `- ${skill.name}: ${skill.description} [${skill.source}]`).join("\n")
    : "(no skills available)";
}

function applyOrchestratorConfig(
  agent: Agent,
  model: Model<any>,
  skills: SkillRecord[],
  options: CreateOrchestratorOptions = {},
): void {
  const requireExecutionConfirm = options.requireExecutionConfirm ?? true;

  agent.state.systemPrompt = ORCHESTRATOR_PROMPT(formatSkillMetadata(skills));
  agent.state.tools = [
    makeExecuteCodeTool({
      requireConfirm: requireExecutionConfirm,
      confirmExecution: options.confirmExecution,
    }),
    makeLoadSkillTool(skills),
    makeDelegateToCoderTool(
      () => createCoder(model, options),
      () => buildDelegationContext(agent),
    ),
  ];
}

export function createOrchestrator(
  model: Model<any>,
  skills: SkillRecord[],
  options: CreateOrchestratorOptions = {},
): Agent {
  const agent = new Agent({
    getApiKey: (provider) => resolveApiKey(provider),
    initialState: { model },
  });

  applyOrchestratorConfig(agent, model, skills, options);
  return agent;
}

export function createCoder(model: Model<any>, options: CreateOrchestratorOptions = {}): Agent {
  const requireExecutionConfirm = options.requireExecutionConfirm ?? true;

  return new Agent({
    getApiKey: (provider) => resolveApiKey(provider),
    initialState: {
      systemPrompt: CODER_PROMPT,
      model,
      tools: [
        makeExecuteCodeTool({
          requireConfirm: requireExecutionConfirm,
          confirmExecution: options.confirmExecution,
        }),
      ],
    },
  });
}

export function refreshOrchestratorSkills(
  agent: Agent,
  model: Model<any>,
  skills: SkillRecord[],
  options: CreateOrchestratorOptions = {},
): void {
  applyOrchestratorConfig(agent, model, skills, options);
}
