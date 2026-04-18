import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export type MemoryTarget = 'memory' | 'user';

export interface MemoryUsage {
  used: number;
  limit: number;
  percent: number;
}

export interface MemoryMutationResult {
  changed: boolean;
  entries: string[];
  filePath: string;
  target: MemoryTarget;
  usage: MemoryUsage;
}

const ENTRY_SEPARATOR = '\n\n§\n\n';
const MEMORY_LIMITS: Record<MemoryTarget, number> = {
  memory: 2200,
  user: 1400,
};

const MEMORY_FILES: Record<MemoryTarget, string> = {
  memory: 'MEMORY.md',
  user: 'USER.md',
};

function getMemoryRootDir(): string {
  return process.env.WONIU_MEMORY_DIR
    ? path.resolve(process.env.WONIU_MEMORY_DIR)
    : path.join(os.homedir(), '.woniu', 'memories');
}

export function getMemoryFilePath(target: MemoryTarget): string {
  return path.join(getMemoryRootDir(), MEMORY_FILES[target]);
}

function ensureMemoryDir(): void {
  fs.mkdirSync(getMemoryRootDir(), { recursive: true });
}

function normalizeEntry(entry: string): string {
  return entry.replace(/\r\n/g, '\n').trim();
}

function splitEntries(content: string): string[] {
  const normalized = content.replace(/\r\n/g, '\n').trim();
  if (!normalized) return [];

  return normalized
    .split(/\n\s*§\s*\n/g)
    .map((entry) => normalizeEntry(entry))
    .filter(Boolean);
}

function serializeEntries(entries: string[]): string {
  return entries.join(ENTRY_SEPARATOR);
}

function calculateUsage(target: MemoryTarget, entries: string[]): MemoryUsage {
  const used = serializeEntries(entries).length;
  const limit = MEMORY_LIMITS[target];
  const percent = limit === 0 ? 0 : Math.min(100, Math.round((used / limit) * 100));
  return { used, limit, percent };
}

function assertWithinLimit(target: MemoryTarget, entries: string[]): void {
  const usage = calculateUsage(target, entries);
  if (usage.used > usage.limit) {
    throw new Error(
      `${MEMORY_FILES[target]} exceeds its limit (${usage.used}/${usage.limit} chars). ` +
      'Keep entries shorter or remove old ones.',
    );
  }
}

function buildMutationResult(
  target: MemoryTarget,
  entries: string[],
  changed: boolean,
): MemoryMutationResult {
  return {
    changed,
    entries,
    filePath: getMemoryFilePath(target),
    target,
    usage: calculateUsage(target, entries),
  };
}

function saveEntries(target: MemoryTarget, entries: string[]): MemoryMutationResult {
  const normalizedEntries = entries.map((entry) => normalizeEntry(entry)).filter(Boolean);
  assertWithinLimit(target, normalizedEntries);
  ensureMemoryDir();

  const filePath = getMemoryFilePath(target);
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const content = serializeEntries(normalizedEntries);

  fs.writeFileSync(tempPath, content ? `${content}\n` : '', 'utf8');
  fs.renameSync(tempPath, filePath);

  return buildMutationResult(target, normalizedEntries, true);
}

function findEntryIndex(entries: string[], needle: string): number {
  const normalizedNeedle = normalizeEntry(needle);
  if (!normalizedNeedle) {
    throw new Error('old_text must not be empty.');
  }

  return entries.findIndex((entry) => entry.includes(normalizedNeedle));
}

function dedupeExactEntries(entries: string[]): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];

  for (const entry of entries) {
    if (seen.has(entry)) continue;
    seen.add(entry);
    deduped.push(entry);
  }

  return deduped;
}

export function loadMemory(target: MemoryTarget): string[] {
  const filePath = getMemoryFilePath(target);
  if (!fs.existsSync(filePath)) return [];

  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return splitEntries(content);
  } catch {
    return [];
  }
}

export function saveMemory(target: MemoryTarget, entries: string[]): MemoryMutationResult {
  return saveEntries(target, entries);
}

export function addMemoryEntry(target: MemoryTarget, content: string): MemoryMutationResult {
  const entry = normalizeEntry(content);
  if (!entry) {
    throw new Error('content must not be empty.');
  }

  const existing = loadMemory(target);
  if (existing.includes(entry)) {
    return buildMutationResult(target, existing, false);
  }

  return saveEntries(target, dedupeExactEntries([...existing, entry]));
}

export function replaceMemoryEntry(
  target: MemoryTarget,
  oldText: string,
  content: string,
): MemoryMutationResult {
  const replacement = normalizeEntry(content);
  if (!replacement) {
    throw new Error('content must not be empty.');
  }

  const entries = loadMemory(target);
  const index = findEntryIndex(entries, oldText);
  if (index === -1) {
    throw new Error(`No entry in ${MEMORY_FILES[target]} contains "${normalizeEntry(oldText)}".`);
  }

  const nextEntries = [...entries];
  nextEntries[index] = replacement;
  return saveEntries(target, dedupeExactEntries(nextEntries));
}

export function removeMemoryEntry(target: MemoryTarget, oldText: string): MemoryMutationResult {
  const entries = loadMemory(target);
  const index = findEntryIndex(entries, oldText);
  if (index === -1) {
    throw new Error(`No entry in ${MEMORY_FILES[target]} contains "${normalizeEntry(oldText)}".`);
  }

  const nextEntries = entries.filter((_, entryIndex) => entryIndex !== index);
  return saveEntries(target, nextEntries);
}

function formatPromptSection(tagName: string, entries: string[]): string {
  if (entries.length === 0) return '';
  return [`<${tagName}>`, entries.join('\n§\n'), `</${tagName}>`].join('\n');
}

export function formatMemoryForPrompt(): string {
  const memoryEntries = loadMemory('memory');
  const userEntries = loadMemory('user');
  const sections = [
    formatPromptSection('memory', memoryEntries),
    formatPromptSection('user-profile', userEntries),
  ].filter(Boolean);

  return sections.join('\n\n');
}

export function formatUsageSummary(usage: MemoryUsage): string {
  return `${usage.used}/${usage.limit} chars (${usage.percent}%)`;
}
