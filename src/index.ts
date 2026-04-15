import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import { createOrchestrator, expandSkillCommand, refreshOrchestratorSkills, resolveModel, scanSkills } from "./agents.js";
import type { SkillRecord } from "./tools.js";
import type { ExecutionLanguage } from "./tools.js";

// ═══════════════════════════════════════════════
// Banner
// ═══════════════════════════════════════════════

function printBanner(): void {
  const p1 = "\x1b[38;5;183m";
  const p2 = "\x1b[38;5;147m";
  const p3 = "\x1b[38;5;141m";
  const bold = "\x1b[1m";
  const reset = "\x1b[0m";

  console.log(`
${p1}${bold}██╗    ██╗ ██████╗ ███╗   ██╗██╗██╗   ██╗${reset}
${p1}${bold}██║    ██║██╔═══██╗████╗  ██║██║██║   ██║${reset}
${p2}${bold}██║ █╗ ██║██║   ██║██╔██╗ ██║██║██║   ██║${reset}
${p3}${bold}██║███╗██║██║   ██║██║╚██╗██║██║██║   ██║${reset}
${p3}${bold}╚███╔███╔╝╚██████╔╝██║ ╚████║██║╚██████╔╝${reset}
${p3}${bold} ╚══╝╚══╝  ╚═════╝ ╚═╝  ╚═══╝╚═╝ ╚═════╝${reset}
      ${p2}🐌 Woniu Code v0.1.0${reset}
      ${p2}Minimal Multi-Agent CLI${reset}
`);
}

function printConfig(provider: string, modelId: string, baseUrl?: string): void {
  const dim = "\x1b[38;5;147m";
  const reset = "\x1b[0m";

  console.log(`${dim}Provider: ${provider} | Model: ${modelId}${baseUrl ? ` | URL: ${baseUrl}` : ""}${reset}`);
  console.log(`${dim}Type / to list skills, exit to quit${reset}\n`);
}

// ═══════════════════════════════════════════════
// Slash Commands
// ═══════════════════════════════════════════════

function printSkillList(skills: SkillRecord[]): void {
  const purple = "\x1b[38;5;183m";
  const dim = "\x1b[2m";
  const reset = "\x1b[0m";

  if (skills.length === 0) {
    console.log(`${dim}No skills available.${reset}`);
    return;
  }

  console.log(`${dim}Available skills:${reset}`);
  for (const skill of skills) {
    console.log(`  ${purple}/skill:${skill.name}${reset} ${dim}— ${skill.description} [${skill.source}]${reset}`);
  }
  console.log(`${dim}Usage: /skill:name [your message]${reset}`);
}

// ═══════════════════════════════════════════════
// Confirmation Callback
// ═══════════════════════════════════════════════

function createConfirmExecution(rl: readline.Interface) {
  return async (language: ExecutionLanguage, code: string): Promise<boolean> => {
    const dim = "\x1b[2m";
    const cyan = "\x1b[36m";
    const yellow = "\x1b[33m";
    const reset = "\x1b[0m";

    process.stdout.write(`\n${dim}┌─ Code (${language}) ───────────────${reset}\n`);
    process.stdout.write(`${cyan}${code}${reset}\n`);
    process.stdout.write(`${dim}└──────────────────────────────${reset}\n`);

    const answer = await rl.question(`${yellow}  Execute? [Y/n] ${reset}`);
    return answer.trim().toLowerCase() !== "n";
  };
}

// ═══════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════

async function main(): Promise<void> {
  printBanner();

  const provider = process.env.WONIU_PROVIDER ?? "anthropic";
  const modelId = process.env.WONIU_MODEL ?? "claude-sonnet-4-20250514";
  const baseUrl = process.env.WONIU_BASE_URL;
  const model = resolveModel();

  printConfig(provider, modelId, baseUrl);

  let { skills } = scanSkills();
  const rl = readline.createInterface({ input, output });
  const confirmExecution = createConfirmExecution(rl);

  const agent = createOrchestrator(model, skills, { confirmExecution });

  const dim = "\x1b[2m";
  const purple = "\x1b[38;5;183m";
  const reset = "\x1b[0m";

  agent.subscribe((event) => {
    switch (event.type) {
      case "message_update":
        if (event.assistantMessageEvent.type === "text_delta") {
          process.stdout.write(event.assistantMessageEvent.delta);
        }
        break;
      case "tool_execution_start":
        process.stdout.write(`\n${dim}⚙ ${event.toolName}...${reset}\n`);
        break;
      case "tool_execution_end":
        if (event.isError) {
          process.stdout.write(`${dim}✗ failed${reset}\n`);
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
      console.error(`\x1b[31mError:${reset} ${message}`);
    }
  };

  try {
    while (true) {
      skills = scanSkills().skills;
      refreshOrchestratorSkills(agent, model, skills, { confirmExecution });
      const raw = await rl.question(`${purple}❯ ${reset}`);
      const inputText = raw.trim();

      if (!inputText) continue;

      if (inputText === "exit" || inputText === "quit") {
        console.log(`${dim}👋 Bye!${reset}`);
        break;
      }

      // "/" or "/skills" → list all available skills
      if (inputText === "/" || inputText === "/skills") {
        printSkillList(skills);
        continue;
      }

      // "/skill:name [args]" → expand skill content, send as prompt
      if (inputText.startsWith("/skill:")) {
        const expanded = expandSkillCommand(inputText, skills);
        if (!expanded) {
          console.log(`${dim}Skill not found. Type / to list available skills.${reset}`);
          continue;
        }
        await runPrompt(expanded);
        continue;
      }

      await runPrompt(inputText);
    }
  } finally {
    rl.close();
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\x1b[31mFatal:${"\x1b[0m"} ${message}`);
  process.exit(1);
});
