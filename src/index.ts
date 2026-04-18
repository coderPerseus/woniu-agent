import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import {
  createOrchestrator,
  expandSkillCommand,
  getSlashCommandRecords,
  parseSlashCommandInput,
  refreshOrchestratorSkills,
  resolveModel,
  scanSkills,
  searchSlashCommands,
} from "./agents.js";
import { formatMemoryForPrompt } from "./memory.js";
import { TuiShell } from "./tui-shell.js";
import type { SkillRecord } from "./tools.js";
import type { ExecutionLanguage } from "./tools.js";

const DIM = "\x1b[2m";
const PURPLE = "\x1b[38;5;183m";
const LILAC = "\x1b[38;5;147m";
const PINK = "\x1b[38;5;141m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";
const FORCE_EXIT_WINDOW_MS = 5000;

interface RuntimeOptions {
  yolo: boolean;
}

function formatToolExecutionStart(toolName: string, args?: unknown): string {
  if (toolName !== "execute_code" || !args || typeof args !== "object") {
    return `${DIM}⚙ ${toolName}...${RESET}`;
  }

  const language = "language" in args && typeof args.language === "string"
    ? args.language
    : "unknown";
  const code = "code" in args && typeof args.code === "string"
    ? args.code.trim()
    : "";

  if (!code) {
    return `${DIM}⚙ execute_code${RESET}`;
  }

  return [
    `${DIM}⚙ execute_code${RESET}`,
    `\x1b[36m[${language}]${RESET}`,
    code,
  ].join("\n");
}

function formatToolExecutionEnd(toolName: string): string {
  return toolName === "execute_code"
    ? `${DIM}⚙ execute_code${RESET}`
    : `${DIM}✓ ${toolName}${RESET}`;
}

function extractToolUpdateText(partialResult: unknown): string {
  if (!partialResult || typeof partialResult !== "object" || !("content" in partialResult)) {
    return "";
  }

  const content = partialResult.content;
  if (!Array.isArray(content)) return "";

  return content
    .filter((block): block is { type: "text"; text: string } =>
      typeof block === "object"
      && block !== null
      && "type" in block
      && "text" in block
      && block.type === "text"
      && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
}

function bannerText(): string {
  return `
${PURPLE}${BOLD}██╗    ██╗ ██████╗ ███╗   ██╗██╗██╗   ██╗${RESET}
${PURPLE}${BOLD}██║    ██║██╔═══██╗████╗  ██║██║██║   ██║${RESET}
${LILAC}${BOLD}██║ █╗ ██║██║   ██║██╔██╗ ██║██║██║   ██║${RESET}
${PINK}${BOLD}██║███╗██║██║   ██║██║╚██╗██║██║██║   ██║${RESET}
${PINK}${BOLD}╚███╔███╔╝╚██████╔╝██║ ╚████║██║╚██████╔╝${RESET}
${PINK}${BOLD} ╚══╝╚══╝  ╚═════╝ ╚═╝  ╚═══╝╚═╝ ╚═════╝${RESET}
      ${LILAC}🐌 Woniu Code v0.1.0${RESET}
      ${LILAC}Minimal Multi-Agent CLI${RESET}
`;
}

function parseRuntimeOptions(argv = process.argv.slice(2)): RuntimeOptions {
  return {
    yolo: argv.includes("--yolo"),
  };
}

function printConfig(provider: string, modelId: string, runtimeOptions: RuntimeOptions, baseUrl?: string): void {
  console.log(`${LILAC}Provider: ${provider} | Model: ${modelId}${baseUrl ? ` | URL: ${baseUrl}` : ""}${RESET}`);
  if (runtimeOptions.yolo) {
    console.log(`${DIM}Mode: YOLO | execute_code runs without confirmation${RESET}`);
  }
  console.log(`${DIM}Type / for slash commands, // to send a leading slash, /exit to quit${RESET}`);
  console.log(`${DIM}Press Ctrl+C twice to force exit${RESET}\n`);
}

function formatSlashCommandList(skills: SkillRecord[], query = ""): string {
  const commands = query ? searchSlashCommands(skills, query, 12) : getSlashCommandRecords(skills);

  if (commands.length === 0) {
    return `${DIM}No slash commands matched "${query}".${RESET}`;
  }

  const lines = [query ? `${DIM}Matching slash commands:${RESET}` : `${DIM}Available slash commands:${RESET}`];
  for (const command of commands) {
    lines.push(`  ${PURPLE}${command.command}${RESET} ${DIM}— ${command.description} [${command.source}]${RESET}`);
  }
  lines.push(`${DIM}Usage: /skill:name [your message] or /skill name [your message]${RESET}`);
  return lines.join("\n");
}

function createConfirmExecution(rl: readline.Interface) {
  return async (language: ExecutionLanguage, code: string): Promise<boolean> => {
    const cyan = "\x1b[36m";
    const yellow = "\x1b[33m";

    process.stdout.write(`\n${DIM}┌─ Code (${language}) ───────────────${RESET}\n`);
    process.stdout.write(`${cyan}${code}${RESET}\n`);
    process.stdout.write(`${DIM}└──────────────────────────────${RESET}\n`);

    const answer = await rl.question(`${yellow}  Execute? [Y/n] ${RESET}`);
    return answer.trim().toLowerCase() !== "n";
  };
}

function createForceExitHandler(onFirstInterrupt: () => void): () => void {
  let lastSignalAt = 0;
  let lastHandledAt = 0;

  return () => {
    const now = Date.now();
    if (now - lastHandledAt < 100) {
      return;
    }
    lastHandledAt = now;

    if (now - lastSignalAt <= FORCE_EXIT_WINDOW_MS) {
      process.stdout.write(`\n${DIM}Force exiting...${RESET}\n`);
      process.exit(130);
    }

    lastSignalAt = now;
    onFirstInterrupt();
  };
}

async function runFallbackCli(runtimeOptions: RuntimeOptions): Promise<void> {
  console.log(bannerText());

  const provider = process.env.WONIU_PROVIDER ?? "anthropic";
  const modelId = process.env.WONIU_MODEL ?? "claude-sonnet-4-20250514";
  const baseUrl = process.env.WONIU_BASE_URL;
  const model = resolveModel();
  const memorySnapshot = formatMemoryForPrompt();

  printConfig(provider, modelId, runtimeOptions, baseUrl);

  let { skills } = scanSkills();
  const rl = readline.createInterface({ input, output });
  const confirmExecution = createConfirmExecution(rl);
  const handleForceExit = createForceExitHandler(() => {
    process.stdout.write(`\n${DIM}Press Ctrl+C again to force exit, or use /exit for a clean shutdown.${RESET}\n`);
  });

  process.on("SIGINT", handleForceExit);
  rl.on("SIGINT", handleForceExit);
  const agent = createOrchestrator(model, skills, {
    confirmExecution,
    memorySnapshot,
    requireExecutionConfirm: !runtimeOptions.yolo,
  });

  agent.subscribe((event) => {
    switch (event.type) {
      case "message_update":
        if (event.assistantMessageEvent.type === "text_delta") {
          process.stdout.write(event.assistantMessageEvent.delta);
        }
        break;
      case "tool_execution_start":
        process.stdout.write(`\n${formatToolExecutionStart(event.toolName, event.args)}\n`);
        break;
      case "tool_execution_update": {
        const text = extractToolUpdateText(event.partialResult);
        if (text) {
          process.stdout.write(text);
        }
        break;
      }
      case "tool_execution_end":
        if (event.isError) {
          if (event.toolName === "execute_code") {
            process.stdout.write(`${DIM}✗ failed${RESET}\n${formatToolExecutionEnd(event.toolName)}\n`);
          } else {
            process.stdout.write(`${DIM}✗ failed${RESET}\n`);
          }
        } else {
          process.stdout.write(`${formatToolExecutionEnd(event.toolName)}\n`);
        }
        break;
      case "turn_end":
        process.stdout.write("\n");
        break;
      default:
        break;
    }
  });

  const runPrompt = async (text: string) => {
    try {
      await agent.prompt(text);
      await agent.waitForIdle();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`\x1b[31mError:${RESET} ${message}`);
    }
  };

  try {
    while (true) {
      skills = scanSkills().skills;
      refreshOrchestratorSkills(agent, model, skills, {
        confirmExecution,
        memorySnapshot,
        requireExecutionConfirm: !runtimeOptions.yolo,
      });
      const raw = await rl.question(`${PURPLE}❯ ${RESET}`);
      const inputText = raw.trim();

      if (!inputText) continue;

      const slashCommand = parseSlashCommandInput(inputText, skills);
      if (slashCommand) {
        if (slashCommand.kind === "escaped") {
          await runPrompt(slashCommand.text);
          continue;
        }

        if (slashCommand.kind === "exit") {
          console.log(`${DIM}👋 Bye!${RESET}`);
          break;
        }

        if (slashCommand.kind === "list") {
          console.log(formatSlashCommandList(skills, slashCommand.query));
          continue;
        }

        if (slashCommand.kind === "run-skill") {
          const expanded = expandSkillCommand(inputText, skills);
          if (!expanded) {
            console.log(`${DIM}Skill not found. Type / to list available skills.${RESET}`);
            continue;
          }
          await runPrompt(expanded);
          continue;
        }

        console.log(`${DIM}Unknown slash command: ${slashCommand.command}${RESET}`);
        if (slashCommand.suggestions.length > 0) {
          console.log(`${DIM}Try one of these:${RESET}`);
          for (const suggestion of slashCommand.suggestions) {
            console.log(`  ${PURPLE}${suggestion.command}${RESET} ${DIM}— ${suggestion.description} [${suggestion.source}]${RESET}`);
          }
        } else {
          console.log(`${DIM}Type / to list available commands.${RESET}`);
        }
        continue;
      }

      await runPrompt(inputText);
    }
  } finally {
    process.off("SIGINT", handleForceExit);
    rl.off("SIGINT", handleForceExit);
    rl.close();
  }
}

async function runTuiCli(runtimeOptions: RuntimeOptions): Promise<void> {
  const provider = process.env.WONIU_PROVIDER ?? "anthropic";
  const modelId = process.env.WONIU_MODEL ?? "claude-sonnet-4-20250514";
  const baseUrl = process.env.WONIU_BASE_URL;
  const model = resolveModel();
  const memorySnapshot = formatMemoryForPrompt();

  let { skills } = scanSkills();
  let shell: TuiShell;
  const handleForceExit = createForceExitHandler(() => {
    shell.addSystemMessage("Press Ctrl+C again to force exit, or use /exit for a clean shutdown.");
  });
  shell = new TuiShell(provider, modelId, runtimeOptions.yolo, baseUrl, handleForceExit);
  const confirmExecution = (language: ExecutionLanguage, code: string) => shell.confirmExecution(language, code);
  process.on("SIGINT", handleForceExit);
  const agent = createOrchestrator(model, skills, {
    confirmExecution,
    memorySnapshot,
    requireExecutionConfirm: !runtimeOptions.yolo,
  });

  agent.subscribe((event) => {
    switch (event.type) {
      case "message_update":
        if (event.assistantMessageEvent.type === "text_delta") {
          shell.appendAssistantDelta(event.assistantMessageEvent.delta);
        }
        break;
      case "tool_execution_start":
        shell.addToolExecutionStart(event.toolName, event.args);
        break;
      case "tool_execution_update": {
        const text = extractToolUpdateText(event.partialResult);
        if (text) {
          shell.appendToolExecutionUpdate(text);
        }
        break;
      }
      case "tool_execution_end":
        if (event.isError) {
          shell.addToolExecutionError(event.toolName);
        } else {
          shell.addToolExecutionEnd(event.toolName);
        }
        break;
      case "turn_end":
        shell.endAssistantMessage();
        shell.setBusy(false);
        break;
      default:
        break;
    }
  });

  const runPrompt = async (promptText: string, displayText: string) => {
    shell.addUserMessage(displayText);
    shell.setBusy(true);

    try {
      await agent.prompt(promptText);
      await agent.waitForIdle();
    } catch (error) {
      shell.setBusy(false);
      shell.endAssistantMessage();
      const message = error instanceof Error ? error.message : String(error);
      shell.addErrorMessage(message);
    }
  };

  shell.start();

  try {
    while (true) {
      skills = scanSkills().skills;
      refreshOrchestratorSkills(agent, model, skills, {
        confirmExecution,
        memorySnapshot,
        requireExecutionConfirm: !runtimeOptions.yolo,
      });
      const raw = await shell.ask(skills);
      const inputText = raw.trim();

      if (!inputText) continue;

      const slashCommand = parseSlashCommandInput(inputText, skills);
      if (slashCommand) {
        if (slashCommand.kind === "escaped") {
          await runPrompt(slashCommand.text, slashCommand.text);
          continue;
        }

        if (slashCommand.kind === "exit") {
          shell.addSystemMessage("👋 Bye!");
          break;
        }

        if (slashCommand.kind === "list") {
          shell.addSkillList(skills, slashCommand.query);
          continue;
        }

        if (slashCommand.kind === "run-skill") {
          const expanded = expandSkillCommand(inputText, skills);
          if (!expanded) {
            shell.addSystemMessage("Skill not found. Type / to list available skills.");
            continue;
          }
          await runPrompt(expanded, inputText);
          continue;
        }

        if (slashCommand.suggestions.length > 0) {
          const suggestionLines = [
            `Unknown slash command: ${slashCommand.command}`,
            "Try one of these:",
            ...slashCommand.suggestions.map((suggestion) => `  ${suggestion.command} — ${suggestion.description} [${suggestion.source}]`),
          ];
          shell.addSystemMessage(suggestionLines.join("\n"));
        } else {
          shell.addSystemMessage(`Unknown slash command: ${slashCommand.command}\nType / to list available commands.`);
        }
        continue;
      }

      await runPrompt(inputText, inputText);
    }
  } finally {
    process.off("SIGINT", handleForceExit);
    shell.stop();
  }
}

async function main(): Promise<void> {
  const runtimeOptions = parseRuntimeOptions();

  if (!input.isTTY || !output.isTTY) {
    await runFallbackCli(runtimeOptions);
    return;
  }

  await runTuiCli(runtimeOptions);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\x1b[31mFatal:${RESET} ${message}`);
  process.exit(1);
});
