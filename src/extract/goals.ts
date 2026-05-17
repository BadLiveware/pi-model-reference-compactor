import type { NormalizedBlock } from "../types";
import { nonEmptyLines, clip } from "../core/content";
import { collapseSkillLines } from "../core/skill-collapse";

const SCOPE_CHANGE_RE =
  /\b(instead|actually|change of plan|forget that|new task|switch to|now I want|pivot|let'?s do|stop .* and)\b/i;

const TASK_RE =
  /\b(fix|implement|add|create|build|refactor|debug|investigate|update|remove|delete|migrate|deploy|test|write|set up)\b/i;

const PREFERENCE_RE =
  /\b(prefer(?:s|red|ring)?|always use|never use|please use|please avoid|do not use|don'?t use)\b/i;
const DIRECT_PREFERENCE_RE = /\b(?:prefer(?:s|red|ring)?|please use|please avoid|always use|never use)\b/i;
const PREFERENCE_WITH_TASK_RE =
  /\b(fix|implement|add|create|build|refactor|debug|investigate|update|remove|delete|migrate|deploy|write|set up)\b|\btest\s+(?:with|using|via)\b/i;

const NOISE_SHORT_RE = /^(ok|yes|no|sure|yeah|yep|go|hi|hey|thx|thanks|ok\b.*|y|n|k)\s*[.!?]*$/i;
const VOLATILE_STATUS_RE = /^\s*(?:current blocker|blocker update|status update|next step)\s*:/i;

// Reject lines that are clearly not user goals (pasted output, code, paths, tool dumps)
// or meta-prompt boilerplate (command templates like `/issues` that start with "For each issue:"
// followed by numbered "Read the issue in full..." steps).
const NON_GOAL_RE =
  /^\s*[\[│├└─╭╰]|```|^\s*(=[A-Z]+\(|function |const |let |var |import |export |class )|^(https?:|file:|\/[A-Za-z])|\\n|^\s*For each\b|\bin full\b[^\n]*\b(comments|issue|issues|PRs?|linked)\b/;

const TABLE_OR_STATUS_RE =
  /\b(READY\s+STATUS\s+RESTARTS|\d+\/\d+\s+(?:Running|Pending|Completed|Error|CrashLoopBackOff)\b)/;
const CONFIG_FRAGMENT_RE = /^\s*(?:apiVersion|kind|metadata|labels|annotations|spec|data|creationTimestamp|name|namespace|app(?:\.kubernetes\.io\/[-\w]+)?|chart|grafana_dashboard|heritage|release|resourceVersion|uid)\s*:/i;
const LOG_OR_COMMAND_RE = /^\s*(?:[❯$>]\s+|\{.*"(?:time|level|msg)"\s*:)/;

// Signals that the rest of the user message is a command template (e.g. /issues),
// in which case we should stop collecting goals at the signal line.
const TEMPLATE_SIGNAL_RE =
  /^\s*(For each\b|Do NOT implement\b|Analyze and propose\b|If Task\/context\b|Output:\s*$)/i;

const truncateAtTemplate = (lines: string[]): string[] => {
  const idx = lines.findIndex((l) => TEMPLATE_SIGNAL_RE.test(l));
  return idx >= 0 ? lines.slice(0, idx) : lines;
};

const stripLeadingBullet = (line: string): string =>
  line.replace(/^\s*(?:[-*+]|\d+\.)\s+/, "").trim();

const MAX_GOAL_CHARS = 200;

const isPreferenceOnly = (text: string): boolean =>
  (DIRECT_PREFERENCE_RE.test(text) || PREFERENCE_RE.test(text)) && !PREFERENCE_WITH_TASK_RE.test(text);

const isSubstantiveGoal = (text: string): boolean => {
  const t = text.trim();
  if (t.length <= 5) return false;
  if (t.length > MAX_GOAL_CHARS) return false;
  if (NOISE_SHORT_RE.test(t)) return false;
  if (VOLATILE_STATUS_RE.test(t)) return false;
  if (TABLE_OR_STATUS_RE.test(t)) return false;
  if (CONFIG_FRAGMENT_RE.test(t)) return false;
  if (LOG_OR_COMMAND_RE.test(t)) return false;
  if (NON_GOAL_RE.test(t)) return false;
  if (isPreferenceOnly(t)) return false;
  return true;
};

// Test scope-change / task intent only on the leading portion of a user block
// so that pasted outputs below the actual instruction do not trigger matches.
const LEADING_CHARS = 200;

export interface GoalExtraction {
  stableGoals: string[];
  currentScope: string[];
}

export const extractGoalState = (blocks: NormalizedBlock[]): GoalExtraction => {
  const stableGoals: string[] = [];
  let latestScopeChange: string[] = [];

  for (const b of blocks) {
    if (b.kind !== "user") continue;
    const rawLines = nonEmptyLines(b.text);
    const truncated = truncateAtTemplate(rawLines);
    const lines = collapseSkillLines(truncated.filter(isSubstantiveGoal))
      .map(stripLeadingBullet)
      .filter((l) => l.length > 5);
    if (lines.length === 0) continue;

    if (stableGoals.length === 0) {
      stableGoals.push(...lines.slice(0, 6));
      continue;
    }

    const leading = b.text.slice(0, LEADING_CHARS);
    if (SCOPE_CHANGE_RE.test(leading)) {
      latestScopeChange = lines.slice(0, 3).map((l) => clip(l, MAX_GOAL_CHARS));
    } else if (TASK_RE.test(leading) && lines[0].length > 15) {
      latestScopeChange = lines.slice(0, 2).map((l) => clip(l, MAX_GOAL_CHARS));
    }
  }

  return {
    stableGoals: stableGoals.slice(0, 8),
    currentScope: latestScopeChange.slice(0, 5),
  };
};

export const extractGoals = (blocks: NormalizedBlock[]): string[] =>
  extractGoalState(blocks).stableGoals;
