/** Continuity helpers: bounded text, instruction composition and the deterministic compaction fallback. */
import type { ChatMessage, MemoryEntry } from '@your-bot/contracts';

export const MEMORY_SECTION_LIMIT = 8 * 1024;
export const SKILL_BODY_LIMIT = 32 * 1024;
export const INSTRUCTIONS_LIMIT = 64 * 1024;
export const SUMMARY_LIMIT = 16 * 1024;
export const FALLBACK_SUMMARY_LIMIT = 8 * 1024;
export const AGENT_MEMORY_LIMIT = 2 * 1024;
export const MEMORY_ENTRIES_LIMIT = 500;
export const OWNER_MEMORY_LIMIT = 8 * 1024;

const TRUNCATED = '\n[truncated]';

export function bytes(text: string): number { return Buffer.byteLength(text, 'utf8'); }

/** Longest prefix of `text` within `max` UTF-8 bytes, never splitting a code point. */
export function truncateBytes(text: string, max: number): string {
  if (bytes(text) <= max) return text;
  if (max <= 0) return '';
  const buffer = Buffer.from(text, 'utf8');
  let end = Math.min(max, buffer.length);
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end--;
  return buffer.subarray(0, end).toString('utf8');
}
/** Bounded with a visible marker when cut. */
export function bounded(text: string, max: number): string {
  return bytes(text) <= max ? text : truncateBytes(text, Math.max(0, max - bytes(TRUNCATED))) + TRUNCATED;
}

/**
 * Memory section from entries given newest first, at most `limit` bytes. Whole entries are kept
 * until one does not fit; that entry is truncated into the remaining room so a large newest note
 * is still delivered instead of blocking every older note.
 */
export function memorySection(entries: MemoryEntry[], limit = MEMORY_SECTION_LIMIT): string {
  const header = '## Memory\nNotes saved for this bot (newest first):';
  if (bytes(header) >= limit) return '';
  let text = header;
  for (const entry of entries) {
    const content = entry.content.replace(/\s*\n\s*/g, ' ');
    const line = `\n- ${content}`;
    if (bytes(text + line) <= limit) { text += line; continue; }
    const room = limit - bytes(text) - bytes('\n- ');
    if (room > 32) text += `\n- ${bounded(content, room)}`;
    break;
  }
  return text === header ? '' : text;
}

/**
 * Bot instructions, then memory, then each skill body; total ≤ INSTRUCTIONS_LIMIT. Later sections are
 * cut first, so owner instructions always win over memory and skills.
 */
export function composeInstructions(instructions: string, memory: string, skills: {name: string; body: string}[]): string {
  const sections = [instructions.trim(), memory, ...skills.map(skill => `## Skill: ${skill.name}\n${bounded(skill.body.trim(), SKILL_BODY_LIMIT)}`)].filter(Boolean);
  let result = '';
  for (const section of sections) {
    const next = result ? `${result}\n\n${section}` : section;
    if (bytes(next) <= INSTRUCTIONS_LIMIT) { result = next; continue; }
    const room = INSTRUCTIONS_LIMIT - bytes(result) - (result ? 2 : 0);
    if (room > 64) result = result ? `${result}\n\n${bounded(section, room)}` : bounded(section, room);
    break;
  }
  return result;
}

/**
 * Deterministic compaction summary: the previous summary plus one bounded line per compacted
 * message. When over the limit, the oldest lines are dropped (the newest context matters most).
 */
export function fallbackSummary(previous: string | undefined, messages: ChatMessage[], limit = FALLBACK_SUMMARY_LIMIT): string {
  const header = `Earlier conversation (${messages.length} message${messages.length === 1 ? '' : 's'} compacted):`;
  const lines = messages.map(message => {
    const text = message.content.slice(0, 1000).replace(/\s+/g, " ").trim();
    return `- ${message.role}: ${bounded(text, 200).replace(/\n/g, ' ')}`;
  });
  const prior = previous ? `Previously: ${bounded(previous.replace(/\s+/g, ' ').trim(), Math.floor(limit / 4))}` : '';
  const fixed = [prior, header].filter(Boolean).join('\n');
  const kept: string[] = []; let size = bytes(fixed);
  for (let index = lines.length - 1; index >= 0; index--) {
    const cost = bytes(lines[index]) + 1;
    if (size + cost > limit) break;
    kept.unshift(lines[index]); size += cost;
  }
  return truncateBytes([fixed, ...kept].join('\n'), limit);
}
