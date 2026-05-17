import { clip, firstLine, nonEmptyLines } from "./content";

const LARGE_OUTPUT_CHARS = 500;
const LARGE_OUTPUT_LINES = 12;

const SIGNAL_RE =
  /\b(error|fail(?:ed|ing|ure)?|exception|traceback|panic|fatal|critical|assert|timeout|not found|command not found|ERR_[A-Z0-9_]+|[A-Z][A-Z0-9]+(?:_[A-Z0-9]+){1,}|request_id=|req_[\w-]+)\b/i;

const LOW_VALUE_RE = /^\s*(?:debug|trace|info)\b/i;

const outputIsLarge = (text: string): boolean =>
  text.length > LARGE_OUTPUT_CHARS || text.split("\n").length > LARGE_OUTPUT_LINES;

const salientLine = (text: string): string => {
  const lines = nonEmptyLines(text);
  const signal = lines.find((line) => SIGNAL_RE.test(line) && !LOW_VALUE_RE.test(line));
  if (signal) return clip(signal, 220);
  const nonDebug = lines.find((line) => !LOW_VALUE_RE.test(line));
  if (nonDebug) return clip(nonDebug, 220);
  return firstLine(text, 220);
};

/**
 * Summarize a tool error/result for active prompt state.
 * Large outputs keep a salient failure line and omit bulk that remains
 * recoverable from raw session history through recall.
 */
export const summarizeToolResultForPrompt = (text: string): string => {
  if (!outputIsLarge(text)) return firstLine(text, 180);
  const lineCount = text.split("\n").length;
  const chars = text.length;
  const line = salientLine(text);
  const omitted = `large output omitted: ${lineCount} lines, ${chars} chars`;
  return line ? `${line} (${omitted})` : `(${omitted})`;
};
