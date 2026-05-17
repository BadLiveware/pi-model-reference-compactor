import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import type { Message } from "@mariozechner/pi-ai";
import type { CompactionBenchmarkCase } from "./synthetic-cases";

interface SessionFile {
  path: string;
  size: number;
}

const walkJsonl = async (dir: string): Promise<SessionFile[]> => {
  const entries = await readdir(dir, { withFileTypes: true });
  const out: SessionFile[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...await walkJsonl(path));
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      const s = await stat(path);
      out.push({ path, size: s.size });
    }
  }
  return out;
};

const isMessage = (value: unknown): value is Message =>
  Boolean(value && typeof value === "object" && typeof (value as any).role === "string" && "content" in (value as any));

const loadMessagesFromJsonl = async (path: string): Promise<Message[]> => {
  const text = await readFile(path, "utf8");
  const messages: Message[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry?.type !== "message") continue;
    if (isMessage(entry.message)) messages.push(entry.message);
  }
  return messages;
};

const compactionPointsFor = (messageCount: number): number[] => {
  if (messageCount <= 3) return [];
  const raw = [
    Math.ceil(messageCount * 0.4),
    Math.ceil(messageCount * 0.7),
    messageCount,
  ].filter((point) => point > 2 && point <= messageCount);
  return [...new Set(raw)];
};

export const loadRealSessionCases = async (options: {
  sessionsDir: string;
  limit?: number;
}): Promise<CompactionBenchmarkCase[]> => {
  const limit = Math.max(1, options.limit ?? 2);
  const files = (await walkJsonl(options.sessionsDir))
    .sort((a, b) => b.size - a.size)
    .slice(0, limit);

  const cases: CompactionBenchmarkCase[] = [];
  for (const file of files) {
    const messages = await loadMessagesFromJsonl(file.path);
    const compactionPoints = compactionPointsFor(messages.length);
    if (compactionPoints.length === 0) continue;
    cases.push({
      id: `real-session:${basename(file.path, ".jsonl")}`,
      description: `Real Pi session replay sampled from ${file.path}`,
      messages,
      compactionPoints,
      gold: {
        activeTerms: [],
        recallTerms: [],
      },
    });
  }

  return cases;
};
