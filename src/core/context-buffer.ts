/**
 * Real context buffer.
 *
 * Hooks Pi's `context` event to capture the actual assembled AgentMessage[]
 * that Pi sends to the model. Stores the last N contexts in a rotating
 * buffer file under /tmp/pi-vcc-context-buffer.json.
 *
 * This gives dump-context.ts real data instead of algorithmic guesswork.
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync } from "fs";
import { dirname } from "path";

const BUFFER_PATH = "/tmp/pi-vcc-context-buffer.json";
const MAX_SLOTS = 5;

interface ContextSlot {
  timestamp: string;
  messages: unknown[];
}

interface ContextBuffer {
  slots: ContextSlot[];
}

const readBuffer = (): ContextBuffer => {
  try {
    if (!existsSync(BUFFER_PATH)) return { slots: [] };
    const raw = readFileSync(BUFFER_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.slots)) return parsed;
  } catch {}
  return { slots: [] };
};

const writeBuffer = (buffer: ContextBuffer): void => {
  try {
    const dir = dirname(BUFFER_PATH);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(BUFFER_PATH, JSON.stringify(buffer));
  } catch {
    // best-effort; never crash extension
  }
};

/**
 * Push a context capture into the rotating buffer.
 */
export const pushContextSlot = (slot: ContextSlot): void => {
  const buffer = readBuffer();
  buffer.slots.push(slot);
  while (buffer.slots.length > MAX_SLOTS) {
    buffer.slots.shift();
  }
  writeBuffer(buffer);
};

/**
 * Read all buffered context slots (most recent last).
 */
export const readContextBuffer = (): ContextSlot[] => {
  return readBuffer().slots;
};

/**
 * Get the latest context slot, or undefined if buffer is empty.
 */
export const latestContextSlot = (): ContextSlot | undefined => {
  const slots = readContextBuffer();
  return slots.length > 0 ? slots[slots.length - 1] : undefined;
};
