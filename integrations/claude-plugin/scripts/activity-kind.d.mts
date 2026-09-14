export type ActivityKind = 'coding' | 'documents' | 'research' | 'testing' | 'reviewing' | 'planning' | 'design' | 'delivery' | 'shipping' | 'general';
export const ACTIVITY_KINDS: readonly ActivityKind[];
export function isActivityKind(value: unknown): value is ActivityKind;
export function classifyActivity(toolName: unknown, input: unknown, allowWrapper?: boolean): ActivityKind;
export function nextActivityKind(previous: unknown, event: { type: string; activityKind?: unknown; toolName?: string; retired?: boolean; sessionEnded?: boolean }, status: string): ActivityKind | undefined;
