import * as readline from "node:readline/promises";

import type { SkillRecord } from "./tools.js";
import { getSlashCommandRecords } from "./agents.js";
import type { ExecutionLanguage } from "./tools.js";
import {
  CombinedAutocompleteProvider,
} from "../dist/pi-mono/packages/tui/src/autocomplete.ts";
import { Editor, type EditorTheme } from "../dist/pi-mono/packages/tui/src/components/editor.ts";
import { Text } from "../dist/pi-mono/packages/tui/src/components/text.ts";
import { matchesKey } from "../dist/pi-mono/packages/tui/src/keys.ts";
import { ProcessTerminal } from "../dist/pi-mono/packages/tui/src/terminal.ts";
import { TUI } from "../dist/pi-mono/packages/tui/src/tui.ts";

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const PURPLE = "\x1b[38;5;183m";
const LILAC = "\x1b[38;5;147m";
const PINK = "\x1b[38;5;141m";

function color(code: string, text: string): string {
  return `${code}${text}${RESET}`;
}

function buildBanner(provider: string, modelId: string, yolo = false, baseUrl?: string): string {
  return [
    "",
    `${PURPLE}${BOLD}██╗    ██╗ ██████╗ ███╗   ██╗██╗██╗   ██╗${RESET}`,
    `${PURPLE}${BOLD}██║    ██║██╔═══██╗████╗  ██║██║██║   ██║${RESET}`,
    `${LILAC}${BOLD}██║ █╗ ██║██║   ██║██╔██╗ ██║██║██║   ██║${RESET}`,
    `${PINK}${BOLD}██║███╗██║██║   ██║██║╚██╗██║██║██║   ██║${RESET}`,
    `${PINK}${BOLD}╚███╔███╔╝╚██████╔╝██║ ╚████║██║╚██████╔╝${RESET}`,
    `${PINK}${BOLD} ╚══╝╚══╝  ╚═════╝ ╚═╝  ╚═══╝╚═╝ ╚═════╝${RESET}`,
    `      ${LILAC}🐌 Woniu Code v0.1.0${RESET}`,
    `      ${LILAC}Minimal Multi-Agent CLI${RESET}`,
    "",
    color(LILAC, `Provider: ${provider} | Model: ${modelId}${baseUrl ? ` | URL: ${baseUrl}` : ""}`),
    ...(yolo ? [color(DIM, "Mode: YOLO | execute_code runs without confirmation")] : []),
    color(DIM, "Type / for slash commands, // to send a leading slash, /exit to quit"),
    color(DIM, "Press Ctrl+C twice to force exit"),
  ].join("\n");
}

const editorTheme: EditorTheme = {
  borderColor: (text: string) => color(DIM, text),
  selectList: {
    selectedPrefix: (text: string) => color(PURPLE, text),
    selectedText: (text: string) => `${BOLD}${text}${RESET}`,
    description: (text: string) => color(DIM, text),
    scrollInfo: (text: string) => color(DIM, text),
    noMatch: (text: string) => color(DIM, text),
  },
};

function formatSkillList(skills: SkillRecord[], query = ""): string {
  const commands = getSlashCommandRecords(skills).filter((command) => {
    if (!query) return true;
    const normalizedQuery = query.trim().toLowerCase();
    return command.command.toLowerCase().includes(normalizedQuery)
      || command.description.toLowerCase().includes(normalizedQuery);
  });

  if (commands.length === 0) {
    return color(DIM, `No slash commands matched "${query}".`);
  }

  const lines = [color(DIM, query ? "Matching slash commands:" : "Available slash commands:")];
  for (const command of commands) {
    lines.push(`  ${color(PURPLE, command.command)} ${color(DIM, `— ${command.description} [${command.source}]`)}`);
  }
  lines.push(color(DIM, "Usage: /skill:name [your message] or /skill name [your message]"));
  return lines.join("\n");
}

export class TuiShell {
  private readonly tui = new TUI(new ProcessTerminal());
  private readonly header = new Text("", 1, 0);
  private readonly transcript = new Text("", 1, 0);
  private readonly editor = new Editor(this.tui, editorTheme, {
    paddingX: 1,
    autocompleteMaxVisible: 12,
  });
  private readonly transcriptEntries: string[] = [];
  private pendingSubmitResolve?: (value: string) => void;
  private pendingSubmitReject?: (error: unknown) => void;
  private currentAssistantIndex: number | null = null;
  private started = false;

  constructor(
    provider: string,
    modelId: string,
    yolo = false,
    baseUrl?: string,
    onCtrlC?: () => void,
  ) {
    this.header.setText(buildBanner(provider, modelId, yolo, baseUrl));
    this.editor.onSubmit = (text) => {
      const resolve = this.pendingSubmitResolve;
      if (!resolve) return;
      this.pendingSubmitResolve = undefined;
      this.pendingSubmitReject = undefined;
      resolve(text);
    };

    this.tui.addChild(this.header);
    this.tui.addChild(this.transcript);
    this.tui.addChild(this.editor);
    this.tui.addInputListener((data) => {
      if (matchesKey(data, "ctrl+c")) {
        onCtrlC?.();
        return { consume: true };
      }
      return undefined;
    });
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.tui.setFocus(this.editor);
    this.tui.start();
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.tui.stop();
  }

  setSkills(skills: SkillRecord[]): void {
    const slashCommands = getSlashCommandRecords(skills).map((command) => ({
      name: command.command.slice(1),
      label: command.command,
      description: command.description,
    }));
    this.editor.setAutocompleteProvider(new CombinedAutocompleteProvider(slashCommands, process.cwd()));
    this.tui.requestRender();
  }

  async ask(skills: SkillRecord[]): Promise<string> {
    this.setSkills(skills);
    this.editor.disableSubmit = false;
    this.tui.setFocus(this.editor);
    this.tui.requestRender();

    return new Promise<string>((resolve, reject) => {
      this.pendingSubmitResolve = resolve;
      this.pendingSubmitReject = reject;
    });
  }

  setBusy(isBusy: boolean): void {
    this.editor.disableSubmit = isBusy;
    this.tui.requestRender();
  }

  addUserMessage(text: string): void {
    this.currentAssistantIndex = null;
    this.pushTranscriptEntry(`${color(PURPLE, `${BOLD}You${RESET}`)} ${color(DIM, "·")} ${text}`);
  }

  addSystemMessage(text: string): void {
    this.currentAssistantIndex = null;
    this.pushTranscriptEntry(color(DIM, text));
  }

  addErrorMessage(text: string): void {
    this.currentAssistantIndex = null;
    this.pushTranscriptEntry(color(RED, `Error: ${text}`));
  }

  addSkillList(skills: SkillRecord[], query = ""): void {
    this.currentAssistantIndex = null;
    this.pushTranscriptEntry(formatSkillList(skills, query));
  }

  startAssistantMessage(): void {
    if (this.currentAssistantIndex !== null) return;
    this.currentAssistantIndex = this.transcriptEntries.length;
    this.transcriptEntries.push(`${color(CYAN, `${BOLD}Assistant${RESET}`)} ${color(DIM, "·")} `);
    this.flushTranscript();
  }

  appendAssistantDelta(delta: string): void {
    if (this.currentAssistantIndex === null) {
      this.startAssistantMessage();
    }
    if (this.currentAssistantIndex === null) return;
    this.transcriptEntries[this.currentAssistantIndex] += delta;
    this.flushTranscript();
  }

  endAssistantMessage(): void {
    this.currentAssistantIndex = null;
    this.flushTranscript();
  }

  addToolExecutionStart(toolName: string): void {
    this.currentAssistantIndex = null;
    this.pushTranscriptEntry(color(DIM, `⚙ ${toolName}...`));
  }

  addToolExecutionError(): void {
    this.currentAssistantIndex = null;
    this.pushTranscriptEntry(color(DIM, "✗ failed"));
  }

  async confirmExecution(language: ExecutionLanguage, code: string): Promise<boolean> {
    if (this.started) {
      this.stop();
    }

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      process.stdout.write(`\n${color(DIM, `┌─ Code (${language}) ───────────────`)}\n`);
      process.stdout.write(`${color(CYAN, code)}\n`);
      process.stdout.write(`${color(DIM, "└──────────────────────────────")}\n`);
      const answer = await rl.question(`${color(YELLOW, "  Execute? [Y/n] ")}`);
      return answer.trim().toLowerCase() !== "n";
    } finally {
      rl.close();
      if (!this.started) {
        this.start();
        this.tui.requestRender(true);
      }
    }
  }
  private pushTranscriptEntry(text: string): void {
    this.transcriptEntries.push(text);
    this.flushTranscript();
  }

  private flushTranscript(): void {
    this.transcript.setText(this.transcriptEntries.join("\n\n"));
    this.tui.requestRender();
  }
}
