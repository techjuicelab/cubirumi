export type ActivityKind = 'coding' | 'documents' | 'research' | 'testing' | 'reviewing' | 'planning' | 'design' | 'delivery' | 'shipping' | 'general';
export const ACTIVITY_KINDS: readonly ActivityKind[];
export function isActivityKind(value: unknown): value is ActivityKind;
export function classifyActivity(toolName: unknown, input: unknown, allowWrapper?: boolean): ActivityKind;
export function nextActivityKind(previous: unknown, event: { type: string; activityKind?: unknown; toolName?: string; retired?: boolean; sessionEnded?: boolean }, status: string): ActivityKind | undefined;
export function nextToolName(previous: string | undefined, event: { type: string; toolName?: string; toolPhase?: string; retired?: boolean; sessionEnded?: boolean; lastEventAt?: string }, status: string): string | undefined;
