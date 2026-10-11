// Pure logic shared by the extension and the unit tests. Nothing here may import `vscode`.
//
// The data formats parsed here are Claude Code internals (observed in 2.1.284), not a public API,
// so every parser is defensive and falls back instead of throwing.

/** One `~/.claude/sessions/<pid>.json` file, written by each running Claude Code process. */
export interface RegistryEntry {
  pid: number;
  sessionId: string;
  cwd: string;
  entrypoint?: string;
  name?: string;
  nameSource?: string;
  startedAt?: number;
  /** Process creation time as a Windows FILETIME (100 ns ticks since 1601), as a decimal string. */
  procStart?: string;
  status?: string;
  waitingFor?: string;
  statusUpdatedAt?: number;
  updatedAt?: number;
}

export type DisplayState = 'waiting' | 'working' | 'agents' | 'background' | 'unknown' | 'idle' | 'closed';

export interface StatusInfo {
  state: DisplayState;
  /** Terse text for the output log and screen readers; the row itself shows the status only as an icon. */
  short: string;
  /** Full sentence for the tooltip. */
  long: string;
  /** Codicon id, e.g. `sync~spin`. */
  icon: string;
  /** Theme color id, e.g. `charts.blue`. */
  color?: string;
}

export interface SubagentInfo {
  agentId: string;
  agentType: string;
  description: string;
}

export interface SessionView {
  sessionId: string;
  title: string;
  cwd: string;
  pid?: number;
  status: StatusInfo;
  /** Claude permission mode (`auto`, `plan`, `acceptEdits`, `default`, …) when known. */
  mode?: string;
  /** When the current status began (ms since epoch). */
  since: number;
  /** When this window first saw the session; keeps the order stable within a status group. */
  firstSeenAt: number;
  /** Running subagents. */
  agents: SubagentInfo[];
  /** Subagents ever launched in the session. */
  agentTotal: number;
  /** Background shells and monitors (background agents are in `agents`). */
  backgroundTasks: TaskCount;
  description: string;
}

/** How many of something are running now, out of how many the session ever launched. */
export interface TaskCount {
  running: number;
  total: number;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

function optString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function optNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function parseRegistryEntry(raw: unknown): RegistryEntry | undefined {
  if (!raw || typeof raw !== 'object') {
    return undefined;
  }
  const o = raw as Record<string, unknown>;
  const pid = o.pid;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
    return undefined;
  }
  if (!isUuid(o.sessionId) || typeof o.cwd !== 'string') {
    return undefined;
  }
  return {
    pid,
    sessionId: o.sessionId,
    cwd: o.cwd,
    entrypoint: optString(o.entrypoint),
    name: optString(o.name),
    nameSource: optString(o.nameSource),
    startedAt: optNumber(o.startedAt),
    procStart: typeof o.procStart === 'string' || typeof o.procStart === 'number' ? String(o.procStart) : undefined,
    status: optString(o.status),
    waitingFor: optString(o.waitingFor),
    statusUpdatedAt: optNumber(o.statusUpdatedAt),
    updatedAt: optNumber(o.updatedAt),
  };
}

/** Compares two FILETIME values given as decimal strings. They exceed 2^53, hence BigInt. */
export function procStartMatches(procStart: string, creationFileTime: string, toleranceTicks = 10_000_000n): boolean {
  try {
    const diff = BigInt(procStart) - BigInt(creationFileTime);
    return (diff < 0n ? -diff : diff) <= toleranceTicks;
  } catch {
    return false;
  }
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function describeStatus(
  status: string | undefined,
  waitingFor: string | undefined,
  runningAgents: number,
  live: boolean,
  runningBackgroundTasks = 0,
): StatusInfo {
  if (!live) {
    return {
      state: 'closed',
      short: 'Closed',
      long: 'Closed (no Claude process is running for this session)',
      icon: 'circle-slash',
      color: 'disabledForeground',
    };
  }
  switch (status) {
    case 'busy':
      return { state: 'working', short: 'Working', long: 'Working', icon: 'sync~spin', color: 'charts.blue' };
    case 'waiting': {
      const reason = (waitingFor ?? '').trim();
      if (/permission/i.test(reason)) {
        return { state: 'waiting', short: 'Permission', long: 'Waiting for your permission', icon: 'bell-dot', color: 'charts.orange' };
      }
      if (/input/i.test(reason)) {
        return { state: 'waiting', short: 'Input', long: 'Waiting for your input', icon: 'question', color: 'charts.orange' };
      }
      return {
        state: 'waiting',
        short: reason ? capitalize(reason) : 'Waiting',
        long: reason ? `Waiting: ${reason}` : 'Waiting for you',
        icon: 'bell-dot',
        color: 'charts.orange',
      };
    }
    case 'idle':
      if (runningAgents > 0) {
        return {
          state: 'agents',
          short: 'Agents running',
          long: 'Turn finished, but background agents are still running',
          icon: 'loading~spin',
          color: 'charts.purple',
        };
      }
      if (runningBackgroundTasks > 0) {
        return {
          state: 'background',
          short: 'Waiting on bg tasks',
          long: 'Turn finished, waiting for background tasks',
          icon: 'watch',
          color: 'charts.purple',
        };
      }
      return { state: 'idle', short: 'Idle', long: 'Idle (finished)', icon: 'pass', color: 'charts.green' };
    default:
      return {
        state: 'unknown',
        short: status ? capitalize(status) : 'Unknown',
        long: status ? `Unknown status: ${status}` : 'Unknown status',
        icon: 'circle-outline',
      };
  }
}

export function formatAge(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) {
    return 'now';
  }
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h`;
  }
  return `${Math.floor(hours / 24)}d`;
}

function countText(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

/** e.g. `2 agents`. */
export function agentCountText(count: number): string {
  return countText(count, 'agent', 'agents');
}

/** e.g. `1 bg task`. */
export function bgTaskCountText(count: number): string {
  return countText(count, 'bg task', 'bg tasks');
}

const MODE_LABELS: Record<string, string> = {
  auto: 'auto',
  plan: 'plan',
  acceptEdits: 'edits',
  default: 'ask',
  bypassPermissions: 'bypass',
};

const MODE_NAMES: Record<string, string> = {
  auto: 'Auto',
  plan: 'Plan',
  acceptEdits: 'Accept edits',
  default: 'Ask before edits',
  bypassPermissions: 'Bypass permissions',
};

/** Short label for the row, e.g. `edits` for acceptEdits. */
export function modeLabel(mode: string | undefined): string | undefined {
  return mode ? (MODE_LABELS[mode] ?? mode) : undefined;
}

/** Full name for the tooltip. */
export function modeName(mode: string | undefined): string | undefined {
  return mode ? (MODE_NAMES[mode] ?? mode) : undefined;
}

/**
 * The compact row description, e.g. `auto · 1 agent · 2 bg tasks · 3m`. The icon shows the status.
 * Counts are of what is running now, and appear only while something is.
 */
export function describeRow(agents: number, background: number, since: number, now: number, mode?: string): string {
  const parts: string[] = [];
  const label = modeLabel(mode);
  if (label) {
    parts.push(label);
  }
  if (agents > 0) {
    parts.push(agentCountText(agents));
  }
  if (background > 0) {
    parts.push(bgTaskCountText(background));
  }
  parts.push(formatAge(now - since));
  return parts.join(' · ');
}

/** Claude's own per-session mode record (`session-permission-modes/<sessionId>.json`), written when the user picks a mode. */
export interface StoredMode {
  mode?: string;
  updatedAt?: number;
}

export function parseStoredMode(raw: unknown): StoredMode | undefined {
  if (!raw || typeof raw !== 'object') {
    return undefined;
  }
  const o = raw as Record<string, unknown>;
  return { mode: optString(o.mode), updatedAt: optNumber(o.updatedAt) };
}

/**
 * Whichever is newer: the mode seen in the transcript, or the one the user last picked in Claude's UI.
 * A session with neither (no prompt yet) is still in Claude's initial mode.
 */
export function resolveMode(
  transcript: Pick<TranscriptState, 'mode' | 'modeAt'>,
  stored: StoredMode | undefined,
  initialMode?: string,
): string | undefined {
  if (stored?.mode && stored.updatedAt !== undefined && stored.updatedAt > (transcript.modeAt ?? 0)) {
    return stored.mode;
  }
  if (transcript.mode === undefined && transcript.modeAt === undefined) {
    return initialMode;
  }
  return transcript.mode;
}

const STATE_RANK: Record<DisplayState, number> = {
  waiting: 0,
  working: 1,
  agents: 1,
  background: 1,
  unknown: 2,
  idle: 3,
  closed: 4,
};

/** Sessions that need you first, then active ones, then finished ones; stable within a group. */
export function compareSessions(a: SessionView, b: SessionView): number {
  return (
    STATE_RANK[a.status.state] - STATE_RANK[b.status.state] ||
    b.firstSeenAt - a.firstSeenAt ||
    a.sessionId.localeCompare(b.sessionId)
  );
}

/**
 * A removed session comes back once something happens in it after removal: it starts working or needs you,
 * or its transcript gets a new entry (a turn too short to be caught as Working still leaves one).
 */
export function shouldUndismiss(
  entry: Pick<RegistryEntry, 'status' | 'statusUpdatedAt'>,
  dismissedAt: number,
  lastActivityAt?: number,
): boolean {
  const active = (entry.status === 'busy' || entry.status === 'waiting') && (entry.statusUpdatedAt ?? 0) > dismissedAt;
  return active || (lastActivityAt ?? 0) > dismissedAt;
}

export interface TitleSources {
  name?: string;
  nameSource?: string;
  customTitle?: string;
  aiTitle?: string;
  lastPrompt?: string;
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function pickTitle(s: TitleSources): string {
  if (s.customTitle?.trim()) {
    return oneLine(s.customTitle, 120);
  }
  if (s.name?.trim() && s.nameSource && s.nameSource !== 'derived') {
    return oneLine(s.name, 120);
  }
  if (s.aiTitle?.trim()) {
    return oneLine(s.aiTitle, 120);
  }
  if (s.lastPrompt?.trim()) {
    return oneLine(s.lastPrompt, 80);
  }
  // Same label Claude's own session list uses; the derived registry name (e.g. "stardeus-5f") means nothing to people.
  return BLANK_TITLE;
}

export const BLANK_TITLE = 'Untitled';

/**
 * A session nothing has happened in yet: no prompt, no title. Claude keeps these only in memory, so once one
 * closes it can't be reopened. Claude's view doesn't learn the session's id until the first prompt, so asking
 * Claude to switch to it by id always fails and makes Claude start yet another blank session.
 */
export function isBlankSession(
  t: Pick<TranscriptState, 'hasPrompt' | 'aiTitle' | 'customTitle' | 'lastPrompt'>,
  entry: Pick<RegistryEntry, 'nameSource'>,
): boolean {
  const renamed = entry.nameSource !== undefined && entry.nameSource !== 'derived';
  return !t.hasPrompt && !t.aiTitle && !t.customTitle && !t.lastPrompt && !renamed;
}

// ---------------------------------------------------------------------------------------------
// Session transcript (`projects/<encoded-cwd>/<sessionId>.jsonl`)
// ---------------------------------------------------------------------------------------------

export interface TranscriptState {
  aiTitle?: string;
  customTitle?: string;
  lastPrompt?: string;
  /** Whether any prompt was ever sent in this session. */
  hasPrompt: boolean;
  /** Permission mode as of the latest prompt or mode-change attachment; undefined when it can't be told. */
  mode?: string;
  /** Timestamp (ms) of the line that set `mode`. */
  modeAt?: number;
  /**
   * Timestamp (ms) of the newest timestamped line: a prompt, reply, tool result, command or agent notification.
   * What Claude writes when a session is resumed or closed carries no timestamp, so it doesn't count.
   */
  lastActivityAt?: number;
  /** Task ids reported finished through a `<task-notification>` or stopped with TaskStop: background agents, shells and monitors. */
  finishedTaskIds: Set<string>;
  /** Tool-use ids that received a real `tool_result` (finished foreground agents, among others). */
  completedToolUseIds: Set<string>;
  /** Background shells and monitors ever launched: task id → launch time (ms, 0 when unknown). */
  backgroundTasks: Map<string, number>;
}

export function newTranscriptState(): TranscriptState {
  return { hasPrompt: false, finishedTaskIds: new Set(), completedToolUseIds: new Set(), backgroundTasks: new Map() };
}

/**
 * Background shells and monitors running now, out of all the session launched. Neither outlives the Claude
 * process, so launches from before `startedAt` belong to an earlier run of a resumed session. One stopped from
 * Claude's UI leaves no trace and keeps counting until the process exits.
 */
export function backgroundTaskCount(state: Pick<TranscriptState, 'backgroundTasks' | 'finishedTaskIds'>, startedAt?: number): TaskCount {
  let running = 0;
  for (const [id, launchedAt] of state.backgroundTasks) {
    if (!state.finishedTaskIds.has(id) && (startedAt === undefined || launchedAt >= startedAt)) {
      running++;
    }
  }
  return { running, total: state.backgroundTasks.size };
}

const FINISHED_TASK_STATUSES = new Set(['completed', 'failed', 'killed', 'stopped', 'error', 'cancelled', 'canceled', 'timeout', 'timed_out']);

/** Background agents are acknowledged immediately with this `tool_result`; it does not mean they finished. */
const ASYNC_LAUNCH_ACK = 'Async agent launched';

function textOf(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((block) => (block && typeof block === 'object' && typeof (block as { text?: unknown }).text === 'string' ? (block as { text: string }).text : ''))
      .join('');
  }
  return '';
}

function applyTaskNotification(state: TranscriptState, text: string): boolean {
  if (!text.trimStart().startsWith('<task-notification>')) {
    return false;
  }
  const id = /<task-id>\s*([^<\s]+)\s*<\/task-id>/.exec(text)?.[1];
  if (!id) {
    return false;
  }
  const status = /<status>\s*([^<\s]+)\s*<\/status>/.exec(text)?.[1]?.toLowerCase();
  if (status ? !FINISHED_TASK_STATUSES.has(status) : isOngoingMonitorEvent(text)) {
    return false;
  }
  return addFinishedTask(state, id);
}

/** A monitor reports each event as a status-less notification; only the last one, on expiry, ends it. */
function isOngoingMonitorEvent(text: string): boolean {
  return /<summary>\s*Monitor event/.test(text) && !text.includes('[Monitor expired');
}

function addFinishedTask(state: TranscriptState, id: string): boolean {
  if (state.finishedTaskIds.has(id)) {
    return false;
  }
  state.finishedTaskIds.add(id);
  return true;
}

const MONITOR_STARTED = 'Monitor started';

/**
 * A tool result's structured `toolUseResult`. Bash results carry `backgroundTaskId` when the command runs in the
 * background (asked for, or moved there on timeout), Monitor results a `taskId`, and TaskStop results a `task_id`.
 */
function applyToolUseResult(state: TranscriptState, result: unknown, text: string, at: number | undefined): boolean {
  if (!result || typeof result !== 'object') {
    return false;
  }
  const r = result as { backgroundTaskId?: unknown; taskId?: unknown; task_id?: unknown };
  const launched =
    typeof r.backgroundTaskId === 'string' ? r.backgroundTaskId : typeof r.taskId === 'string' && text.startsWith(MONITOR_STARTED) ? r.taskId : undefined;
  if (launched !== undefined) {
    if (state.backgroundTasks.has(launched)) {
      return false;
    }
    state.backgroundTasks.set(launched, at ?? 0);
    return true;
  }
  // TaskStop: a shell stopped this way gets no `<task-notification>`.
  return typeof r.task_id === 'string' ? addFinishedTask(state, r.task_id) : false;
}

function setMode(state: TranscriptState, mode: string | undefined, timestamp: unknown): boolean {
  const at = typeof timestamp === 'string' ? Date.parse(timestamp) : NaN;
  if (!Number.isNaN(at)) {
    state.modeAt = at;
  }
  if (state.mode === mode) {
    return false;
  }
  state.mode = mode;
  return true;
}

/**
 * Mode changes between prompts show up as attachments. Approving a plan into auto writes `plan_mode_exit`
 * followed by `auto_mode`; approving it into another mode writes no hint, so the mode is unknown until the next prompt.
 */
function applyModeAttachment(state: TranscriptState, type: unknown, timestamp: unknown): boolean {
  switch (type) {
    case 'plan_mode':
    case 'plan_mode_reentry':
      return setMode(state, 'plan', timestamp);
    case 'auto_mode':
      return setMode(state, 'auto', timestamp);
    case 'plan_mode_exit':
      return state.mode === 'plan' ? setMode(state, undefined, timestamp) : false;
    case 'auto_mode_exit':
      return state.mode === 'auto' ? setMode(state, undefined, timestamp) : false;
    default:
      return false;
  }
}

const TIMESTAMP_KEY = '"timestamp":"';

/** A line's own timestamp, found without parsing it: the top-level key always comes after any nested one. */
function lineTimestamp(line: string): number | undefined {
  const start = line.lastIndexOf(TIMESTAMP_KEY);
  if (start === -1) {
    return undefined;
  }
  const from = start + TIMESTAMP_KEY.length;
  const end = line.indexOf('"', from);
  const at = end === -1 ? NaN : Date.parse(line.slice(from, end));
  return Number.isNaN(at) ? undefined : at;
}

/** Folds one transcript line into `state`. Returns true when something visible may have changed. */
export function applyTranscriptLine(state: TranscriptState, line: string): boolean {
  const at = lineTimestamp(line);
  if (at !== undefined && at > (state.lastActivityAt ?? 0)) {
    state.lastActivityAt = at;
  }
  if (
    !line.includes('"ai-title"') &&
    !line.includes('"custom-title"') &&
    !line.includes('"last-prompt"') &&
    !line.includes('task-notification') &&
    !line.includes('"tool_result"') &&
    !line.includes('"permissionMode"') &&
    !line.includes('_mode')
  ) {
    return false;
  }
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(line);
  } catch {
    return false;
  }
  if (!o || typeof o !== 'object') {
    return false;
  }
  switch (o.type) {
    case 'ai-title':
      if (typeof o.aiTitle === 'string' && o.aiTitle !== state.aiTitle) {
        state.aiTitle = o.aiTitle;
        return true;
      }
      return false;
    case 'custom-title':
      if (typeof o.customTitle === 'string' && o.customTitle !== state.customTitle) {
        state.customTitle = o.customTitle;
        return true;
      }
      return false;
    case 'last-prompt':
      if (typeof o.lastPrompt === 'string' && o.lastPrompt !== state.lastPrompt) {
        state.lastPrompt = o.lastPrompt;
        return true;
      }
      return false;
    case 'queue-operation':
      return typeof o.content === 'string' ? applyTaskNotification(state, o.content) : false;
    case 'attachment':
      return applyModeAttachment(state, (o.attachment as { type?: unknown } | undefined)?.type, o.timestamp);
    case 'user': {
      // Prompts record the mode they were sent in.
      let changed = false;
      if (typeof o.permissionMode === 'string') {
        changed = !state.hasPrompt;
        state.hasPrompt = true;
        changed = setMode(state, o.permissionMode, o.timestamp) || changed;
      }
      const content = (o.message as { content?: unknown } | undefined)?.content;
      if (typeof content === 'string') {
        return applyTaskNotification(state, content) || changed;
      }
      if (!Array.isArray(content)) {
        return changed;
      }
      for (const block of content) {
        if (!block || typeof block !== 'object') {
          continue;
        }
        const b = block as { type?: unknown; tool_use_id?: unknown; content?: unknown; text?: unknown };
        if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
          const text = textOf(b.content);
          if (!text.startsWith(ASYNC_LAUNCH_ACK) && !state.completedToolUseIds.has(b.tool_use_id)) {
            state.completedToolUseIds.add(b.tool_use_id);
            changed = true;
          }
          changed = applyToolUseResult(state, o.toolUseResult, text, at) || changed;
        } else if (b.type === 'text' && typeof b.text === 'string') {
          changed = applyTaskNotification(state, b.text) || changed;
        }
      }
      return changed;
    }
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------------------------
// Subagents (`projects/<encoded-cwd>/<sessionId>/subagents/agent-<agentId>.{jsonl,meta.json}`)
// ---------------------------------------------------------------------------------------------

export interface AgentMeta {
  agentId: string;
  agentType: string;
  description: string;
  toolUseId?: string;
  spawnDepth: number;
  background: boolean;
}

export function parseAgentMeta(agentId: string, raw: unknown): AgentMeta | undefined {
  if (!raw || typeof raw !== 'object') {
    return undefined;
  }
  const o = raw as Record<string, unknown>;
  return {
    agentId,
    agentType: optString(o.agentType) ?? 'agent',
    description: optString(o.description) ?? '',
    toolUseId: optString(o.toolUseId),
    spawnDepth: optNumber(o.spawnDepth) ?? 1,
    background: o.requestShape === 'background',
  };
}

/** Whether the parent session's transcript already reports this agent as finished. */
export function isAgentReportedDone(meta: AgentMeta, transcript: TranscriptState): boolean {
  if (transcript.finishedTaskIds.has(meta.agentId)) {
    return true;
  }
  return !meta.background && meta.toolUseId !== undefined && transcript.completedToolUseIds.has(meta.toolUseId);
}

/** A subagent transcript whose last line is an assistant `end_turn` belongs to a finished agent. */
export function isFinishedAgentLine(line: string): boolean {
  try {
    const o = JSON.parse(line) as { type?: unknown; message?: { stop_reason?: unknown } };
    return o.type === 'assistant' && o.message?.stop_reason === 'end_turn';
  } catch {
    return false;
  }
}
