/**
 * Real context buffer.
 *
 * Hooks Pi's `context` event to capture the actual assembled AgentMessage[]
 * that Pi sends to the model. Stores per-session rotating buffers under
 * /tmp/pi-vcc-context-buffers/<session-hash>.json.
 *
 * This gives dump-context.ts real data instead of algorithmic guesswork.
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync } from "fs";
import { dirname } from "path";
import { createHash } from "crypto";

const BUFFER_DIR = "/tmp/pi-vcc-context-buffers";
const MAX_SLOTS = 3;

interface ContextSlot {
  timestamp: string;
  messages: unknown[];
}

interface ContextBuffer {
  slots: ContextSlot[];
}

const sessionKey = (sessionFile: string): string => {
  // Short hash of the session file path for isolation
  return createHash("sha256").update(sessionFile).digest("hex").slice(0, 12);
};

const bufferPath = (sessionFile: string): string =>
  `${BUFFER_DIR}/${sessionKey(sessionFile)}.json`;

const readBuffer = (sessionFile: string): ContextBuffer => {
  try {
    const path = bufferPath(sessionFile);
    if (!existsSync(path)) return { slots: [] };
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.slots)) return parsed;
  } catch {}
  return { slots: [] };
};

const writeBuffer = (sessionFile: string, buffer: ContextBuffer): void => {
  try {
    const dir = BUFFER_DIR;
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(bufferPath(sessionFile), JSON.stringify(buffer));
  } catch {
    // best-effort; never crash extension
  }
};

/**
 * Push a context capture into the per-session rotating buffer.
 */
export const pushContextSlot = (
  sessionFile: string,
  slot: ContextSlot,
): void => {
  const buffer = readBuffer(sessionFile);
  buffer.slots.push(slot);
  while (buffer.slots.length > MAX_SLOTS) {
    buffer.slots.shift();
  }
  writeBuffer(sessionFile, buffer);
};

/**
 * Read all buffered context slots for a session (most recent last).
 */
export const readContextBuffer = (sessionFile: string): ContextSlot[] => {
  return readBuffer(sessionFile).slots;
};

/**
 * Get the latest context slot for a session, or undefined if buffer is empty.
 */
export const latestContextSlot = (
  sessionFile: string,
): ContextSlot | undefined => {
  const slots = readContextBuffer(sessionFile);
  return slots.length > 0 ? slots[slots.length - 1] : undefined;
};

/**
 * List all buffered sessions. Returns { sessionFile, slotCount, latestTimestamp }.
 */
export const listBufferedSessions = (): Array<{
  file: string;
  slots: number;
  latest: string;
}> => {
  try {
    if (!existsSync(BUFFER_DIR)) return [];
    const { readdirSync } = require("fs");
    const files = readdirSync(BUFFER_DIR).filter((f: string) =>
      f.endsWith(".json"),
    );
    const results: Array<{ file: string; slots: number; latest: string }> = [];
    for (const f of files) {
      try {
        const raw = readFileSync(`${BUFFER_DIR}/${f}`, "utf-8");
        const data = JSON.parse(raw);
        const slots = data?.slots;
        if (Array.isArray(slots) && slots.length > 0) {
          results.push({
            file: f.replace(".json", ""),
            slots: slots.length,
            latest: slots[slots.length - 1].timestamp,
          });
        }
      } catch {}
    }
    return results.sort(
      (a, b) => new Date(b.latest).getTime() - new Date(a.latest).getTime(),
    );
  } catch {
    return [];
  }
};
