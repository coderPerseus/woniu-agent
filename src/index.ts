import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import { createOrchestrator, resolveModel } from "./agents.js";
import type { ExecutionLanguage } from "./tools.js";

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
  console.log(`${dim}Type "exit" to quit${reset}\n`);
}

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

async function main(): Promise<void> {
  printBanner();

  const provider = process.env.WONIU_PROVIDER ?? "anthropic";
  const modelId = process.env.WONIU_MODEL ?? "claude-sonnet-4-20250514";
  const baseUrl = process.env.WONIU_BASE_URL;
  const model = resolveModel();

  printConfig(provider, modelId, baseUrl);

  const rl = readline.createInterface({ input, output });
  const agent = createOrchestrator(model, {
    confirmExecution: createConfirmExecution(rl),
  });

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

  try {
    while (true) {
      const raw = await rl.question(`${purple}❯ ${reset}`);
      const inputText = raw.trim();

      if (!inputText) continue;

      if (inputText === "exit" || inputText === "quit") {
        console.log(`${dim}👋 Bye!${reset}`);
        break;
      }

      try {
        await agent.prompt(inputText);
        await agent.waitForIdle();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`\x1b[31mError:${reset} ${message}`);
      }
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
