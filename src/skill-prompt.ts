import { clearLine, clearScreenDown, cursorTo, emitKeypressEvents, moveCursor } from "node:readline";
import { stdin as input, stdout as output } from "node:process";
import * as readline from "node:readline/promises";

import type { SkillRecord } from "./tools.js";

interface SkillPromptOptions {
  getSkills: () => SkillRecord[];
  maxVisible?: number;
  fallbackAsk?: (prompt: string) => Promise<string>;
}

interface SkillSuggestion {
  command: string;
  description: string;
  source: SkillRecord["source"];
}

function stripAnsi(value: string): string {
  return value.replace(/\x1B\[[0-9;]*m/g, "");
}

function textWidth(value: string): number {
  return [...stripAnsi(value)].length;
}

export class SkillPrompt {
  private readonly getSkills: () => SkillRecord[];
  private readonly maxVisible: number;
  private readonly fallbackAsk?: (prompt: string) => Promise<string>;
  private readonly promptText = "❯ ";
  private readonly promptPrefix = "\x1b[38;5;183m❯ \x1b[0m";
  private readonly dim = "\x1b[2m";
  private readonly highlight = "\x1b[48;5;183m\x1b[38;5;16m";
  private readonly accent = "\x1b[38;5;183m";
  private readonly reset = "\x1b[0m";

  private buffer = "";
  private suggestions: SkillSuggestion[] = [];
  private selectedIndex = 0;
  private renderedSuggestionLines = 0;
  private isActive = false;

  constructor(options: SkillPromptOptions) {
    this.getSkills = options.getSkills;
    this.maxVisible = options.maxVisible ?? 8;
    this.fallbackAsk = options.fallbackAsk;
  }

  async ask(): Promise<string> {
    if (!input.isTTY || !output.isTTY) {
      if (this.fallbackAsk) {
        return this.fallbackAsk(this.promptPrefix);
      }

      const rl = readline.createInterface({ input, output });
      try {
        return await rl.question(this.promptPrefix);
      } finally {
        rl.close();
      }
    }

    this.buffer = "";
    this.suggestions = [];
    this.selectedIndex = 0;
    this.renderedSuggestionLines = 0;
    this.isActive = true;

    emitKeypressEvents(input);
    if (input.isTTY) input.setRawMode(true);

    this.render();

    return new Promise<string>((resolve, reject) => {
      let closed = false;

      const finish = (preservePrompt = false) => {
        if (closed) return;
        closed = true;
        input.off("keypress", onKeypress);
        this.cleanup(preservePrompt);
      };

      const onKeypress = (_chunk: string, key: { name?: string; sequence?: string; ctrl?: boolean }) => {
        if (!this.isActive) return;

        if (key.ctrl && key.name === "c") {
          finish();
          reject(new Error("SIGINT"));
          return;
        }

        switch (key.name) {
          case "return":
          case "enter": {
            const value = this.buffer;
            finish(true);
            output.write("\n");
            resolve(value);
            return;
          }
          case "backspace":
            if (this.buffer.length > 0) {
              this.buffer = this.buffer.slice(0, -1);
              this.updateSuggestions();
            }
            this.render();
            return;
          case "tab":
            if (this.suggestions.length > 0) {
              this.acceptSuggestion();
            }
            this.render();
            return;
          case "up":
            if (this.suggestions.length > 0) {
              this.selectedIndex = (this.selectedIndex - 1 + this.suggestions.length) % this.suggestions.length;
              this.render();
            }
            return;
          case "down":
            if (this.suggestions.length > 0) {
              this.selectedIndex = (this.selectedIndex + 1) % this.suggestions.length;
              this.render();
            }
            return;
          case "escape":
            this.suggestions = [];
            this.selectedIndex = 0;
            this.render();
            return;
          default:
            break;
        }

        if (key.sequence && !key.ctrl && key.sequence >= " ") {
          this.buffer += key.sequence;
          this.updateSuggestions();
          this.render();
        }
      };

      input.on("keypress", onKeypress);
    });
  }

  private cleanup(preservePrompt = false): void {
    if (!this.isActive) return;
    this.isActive = false;

    if (this.renderedSuggestionLines > 0) {
      moveCursor(output, 0, -this.renderedSuggestionLines);
    }
    cursorTo(output, 0);
    if (preservePrompt) {
      clearLine(output, 0);
      output.write(`${this.promptPrefix}${this.buffer}`);
      clearScreenDown(output);
    } else {
      clearScreenDown(output);
    }

    if (input.isTTY) input.setRawMode(false);
  }

  private updateSuggestions(): void {
    const inputText = this.buffer.trimStart();
    const match = inputText.match(/^\/skill(?::([^ ]*))?$/);

    if (!match) {
      this.suggestions = [];
      this.selectedIndex = 0;
      return;
    }

    const query = (match[1] ?? "").toLowerCase();
    const suggestions = this.getSkills()
      .filter((skill) => skill.name.toLowerCase().includes(query))
      .map((skill) => ({
        command: `/skill:${skill.name}`,
        description: skill.description,
        source: skill.source,
      }))
      .sort((left, right) => left.command.localeCompare(right.command));

    this.suggestions = suggestions.slice(0, this.maxVisible);
    if (this.selectedIndex >= this.suggestions.length) {
      this.selectedIndex = 0;
    }
  }

  private acceptSuggestion(): void {
    const suggestion = this.suggestions[this.selectedIndex];
    if (!suggestion) return;
    this.buffer = `${suggestion.command} `;
    this.updateSuggestions();
  }

  private render(): void {
    if (this.renderedSuggestionLines > 0) {
      moveCursor(output, 0, -this.renderedSuggestionLines);
    }

    cursorTo(output, 0);
    clearLine(output, 0);
    clearScreenDown(output);

    output.write(`${this.promptPrefix}${this.buffer}`);

    const suggestions = this.suggestions.slice(0, this.maxVisible);
    for (let index = 0; index < suggestions.length; index += 1) {
      const suggestion = suggestions[index];
      const command = index === this.selectedIndex
        ? `${this.highlight}${suggestion.command}${this.reset}`
        : `${this.accent}${suggestion.command}${this.reset}`;
      output.write(`\n${command} ${this.dim}— ${suggestion.description} [${suggestion.source}]${this.reset}`);
    }

    this.renderedSuggestionLines = suggestions.length;
    if (suggestions.length > 0) {
      moveCursor(output, 0, -suggestions.length);
    }
    cursorTo(output, textWidth(this.promptText) + textWidth(this.buffer));
  }
}
