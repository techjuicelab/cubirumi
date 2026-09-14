import { activityNames, type ActivityKind } from './protocol.ts';
import { isActivityKind } from '../integrations/claude-plugin/scripts/activity-kind.mjs';
import { STATUS_STYLE, EXTERNAL_CALL_LABEL, EXTERNAL_TOOL_NAME } from './status-style.ts';
import { isWorkingStatus } from './work-activity.ts';
export type ObservedActivity = { status: string; task?: string; toolName?: string; activityKind?: ActivityKind };
export type ActivityMessage = { text: string; compactText: string; fullText: string };
export const ACTIVITY_BUBBLE_HEIGHT = 32;

// Quiet statuses have no balloon text; every other caption comes from the shared status table.
const STATUS_TEXT: Record<string, string> = {
  working: STATUS_STYLE.working.label, thinking: STATUS_STYLE.thinking.label, reviewing: STATUS_STYLE.reviewing.label,
  approval: STATUS_STYLE.approval.label, done: STATUS_STYLE.done.label, error: STATUS_STYLE.error.label,
};
const segments = new Intl.Segmenter('ko', { granularity: 'grapheme' });

function clean(value: unknown): string {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/gu, ' ').replace(/\s+/gu, ' ').trim() : '';
}

function shorten(value: string, limit: number): string {
  const parts = [...segments.segment(value)].map(part => part.segment);
  return parts.length > limit ? `${parts.slice(0, limit - 1).join('')}…` : value;
}

/** Summarize observed fields only. Ended/idle tasks must not look like a tool is still running. */
export function activityMessage(activity: ObservedActivity): ActivityMessage {
  if (activity.status === 'idle' || activity.status === 'waiting') return { text: '', compactText: '', fullText: '' };
  let fullText = '';
  if (activity.status === 'done') fullText = STATUS_TEXT.done!;
  // Same rule as isExternalCall: a working-family status on the external tool is a phone call, whatever the activity kind.
  else if (isWorkingStatus(activity.status) && activity.toolName === EXTERNAL_TOOL_NAME) fullText = EXTERNAL_CALL_LABEL;
  else if (isActivityKind(activity.activityKind)) {
    const label = activityNames[activity.activityKind];
    fullText = activity.status === 'approval' ? `${label} · ${STATUS_STYLE.approval.label}`
      : activity.status === 'error' ? `${label} · ${STATUS_STYLE.error.label}`
        : `${label} 중`;
  }
  else {
    fullText = clean(activity.task);
    const tool = clean(activity.toolName);
    if (!fullText && activity.status === 'working' && tool) fullText = `${tool} 사용 중`;
    if (!fullText) fullText = STATUS_TEXT[activity.status] ?? '';
  }
  fullText = shorten(fullText, 160);
  return { fullText, text: shorten(fullText, 28), compactText: shorten(fullText, 18) };
}

export function activityBubbleWidth(text: string, compact: boolean): number {
  const width = [...segments.segment(text)].reduce((sum, part) =>
    sum + (/^[\x20-\x7e]+$/u.test(part.segment) ? part.segment.length * (compact ? 5.8 : 6.4) : compact ? 11 : 12), 20);
  return Math.ceil(Math.max(76, Math.min(compact ? 174 : 220, width)));
}

export type BubbleCandidate = {
  id: string; x: number; y: number; width: number; priority: number; nameVisible: boolean; nameWidth?: number;
};
export type BubblePlacement = { id: string; left: number; top: number; width: number; tailX: number };

/** Keep text at a readable CSS size; crowded labels disappear rather than cover another employee. */
export function placeActivityBubbles(candidates: BubbleCandidate[], width: number, height: number,
  previouslyVisible: ReadonlySet<string> = new Set()): BubblePlacement[] {
  const margin = 8;
  const placed: BubblePlacement[] = [];
  const ordered = [...candidates].sort((a, b) => b.priority - a.priority
    || Number(previouslyVisible.has(b.id)) - Number(previouslyVisible.has(a.id))
    || Math.hypot(a.x - width / 2, a.y - height / 2) - Math.hypot(b.x - width / 2, b.y - height / 2)
    || a.id.localeCompare(b.id));
  for (const candidate of ordered) {
    if (!Number.isFinite(candidate.x) || !Number.isFinite(candidate.y) || candidate.x < 0 || candidate.x > width || candidate.y < 0 || candidate.y > height) continue;
    const bubbleWidth = Math.min(candidate.width, width - margin * 2);
    if (bubbleWidth < 60) continue;
    const top = candidate.y - ACTIVITY_BUBBLE_HEIGHT - (candidate.nameVisible ? 31 : 9);
    const left = Math.max(margin, Math.min(width - margin - bubbleWidth, candidate.x - bubbleWidth / 2));
    if (top < margin || top + ACTIVITY_BUBBLE_HEIGHT > height - margin) continue;
    const overlap = placed.some(other => left < other.left + other.width + 8 && left + bubbleWidth + 8 > other.left
      && top < other.top + ACTIVITY_BUBBLE_HEIGHT + 9 && top + ACTIVITY_BUBBLE_HEIGHT + 9 > other.top);
    if (overlap) continue;
    const coversName = candidates.some(other => other.id !== candidate.id && other.nameVisible
      && left < other.x + (other.nameWidth ?? 180) / 2 + 4 && left + bubbleWidth > other.x - (other.nameWidth ?? 180) / 2 - 4
      && top < other.y + 4 && top + ACTIVITY_BUBBLE_HEIGHT > other.y - 27);
    if (coversName) continue;
    placed.push({ id: candidate.id, left, top, width: bubbleWidth,
      tailX: Math.max(12, Math.min(bubbleWidth - 12, candidate.x - left)) });
  }
  return placed;
}
