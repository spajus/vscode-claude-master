import * as vscode from 'vscode';
import {
  BLANK_TITLE,
  compareSessions,
  describeRow,
  describeStatus,
  isBlankSession,
  modeLabel,
  pickTitle,
  RegistryEntry,
  resolveMode,
  SessionView,
  shouldUndismiss,
} from './core/model';
import { ClaudeModeStore } from './modeStore';
import { OwnershipChecker } from './processInfo';
import { SessionRegistry } from './registry';
import { SessionStore } from './sessionStore';
import { SubagentTracker } from './subagents';
import { TranscriptReader } from './transcript';

const POLL_MS = 2000;
const FORGET_CLOSED_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

/** The mode Claude starts new sessions in, read the same way Claude does (user-level setting; "manual" means default). */
function initialPermissionMode(): string | undefined {
  const value = vscode.workspace.getConfiguration('claudeCode').inspect<string>('initialPermissionMode')?.globalValue;
  return value === 'manual' ? 'default' : value;
}

/** Builds the session list from the registry, transcripts and stored state, and keeps it current. */
export class SessionController implements vscode.Disposable {
  private readonly ownership: OwnershipChecker;
  private readonly registry: SessionRegistry;
  private readonly readers = new Map<string, TranscriptReader>();
  private readonly subagents = new SubagentTracker();
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changeEmitter.event;

  private views: SessionView[] = [];
  private liveIds = new Set<string>();
  /** Live sessions with no prompt yet; only the newest is listed. */
  private blankIds = new Set<string>();
  private signature = '';
  private lastLogged?: string;
  private readonly pollTimer: NodeJS.Timeout;
  private scheduled?: NodeJS.Timeout;
  private cycleQueued = false;
  /** Serializes refresh cycles and user actions so neither overwrites the other's stored state. */
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly store: SessionStore,
    private readonly modes: ClaudeModeStore,
    private readonly log: vscode.LogOutputChannel,
  ) {
    this.ownership = new OwnershipChecker(log);
    this.ownership.onDidResolve(() => this.refresh(0));
    this.registry = new SessionRegistry(this.ownership, () => this.refresh(150));
    this.pollTimer = setInterval(() => this.refresh(0), POLL_MS);
    this.refresh(0);
  }

  get sessions(): readonly SessionView[] {
    return this.views;
  }

  /** Whether the session is live with no prompt yet, so Claude can't be switched to it by id. */
  isBlank(sessionId: string): boolean {
    return this.blankIds.has(sessionId);
  }

  refresh(delayMs = 0): void {
    if (this.scheduled) {
      return;
    }
    this.scheduled = setTimeout(() => {
      this.scheduled = undefined;
      this.queueCycle();
    }, delayMs);
  }

  async remove(sessionIds: string[]): Promise<void> {
    await this.exclusive(async () => {
      const known = this.store.known;
      const dismissed = this.store.dismissed;
      const now = Date.now();
      // The one Untitled row stands for every blank session; removing it removes them all,
      // otherwise the next-newest blank one would just take its place.
      const ids = sessionIds.some((id) => this.blankIds.has(id)) ? [...sessionIds, ...this.blankIds] : sessionIds;
      for (const id of ids) {
        if (this.liveIds.has(id)) {
          dismissed[id] = now;
        } else {
          delete known[id];
          delete dismissed[id];
        }
      }
      await this.store.setKnown(known);
      await this.store.setDismissed(dismissed);
    });
    this.queueCycle();
  }

  removeInactive(): Promise<void> {
    const ids = this.views.filter((v) => v.status.state === 'idle' || v.status.state === 'closed').map((v) => v.sessionId);
    return this.remove(ids);
  }

  async restoreRemoved(): Promise<void> {
    await this.exclusive(() => Promise.resolve(this.store.setDismissed({})));
    this.queueCycle();
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.chain.then(fn);
    this.chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private queueCycle(): void {
    if (this.cycleQueued) {
      return;
    }
    this.cycleQueued = true;
    void this.exclusive(async () => {
      this.cycleQueued = false;
      try {
        await this.cycle();
      } catch (err) {
        this.log.error('Refreshing Claude sessions failed:', err instanceof Error ? (err.stack ?? err.message) : String(err));
      }
    });
  }

  private async cycle(): Promise<void> {
    const now = Date.now();
    const entries = await this.registry.scan();
    const live = new Map<string, RegistryEntry>(entries.map((e) => [e.sessionId, e]));
    for (const id of [...this.readers.keys()]) {
      if (!live.has(id)) {
        this.readers.delete(id);
        this.subagents.forget(id);
        this.modes.forget(id);
      }
    }

    const known = this.store.known;
    const dismissed = this.store.dismissed;
    let knownChanged = false;
    let dismissedChanged = false;
    const views: SessionView[] = [];
    const blankViews: SessionView[] = [];
    const blankIds = new Set<string>();

    for (const entry of entries) {
      let reader = this.readers.get(entry.sessionId);
      if (!reader) {
        reader = new TranscriptReader(entry.sessionId);
        this.readers.set(entry.sessionId, reader);
      }
      await reader.update();
      const sessionDir = reader.sessionDir;
      const agents = sessionDir ? await this.subagents.running(entry.sessionId, sessionDir, entry.startedAt, reader.state) : [];
      const title = pickTitle({
        name: entry.name,
        nameSource: entry.nameSource,
        customTitle: reader.state.customTitle,
        aiTitle: reader.state.aiTitle,
        lastPrompt: reader.state.lastPrompt,
      });
      const blank = isBlankSession(reader.state, entry);

      const previous = known[entry.sessionId];
      const firstSeenAt = previous?.firstSeenAt ?? entry.startedAt ?? now;
      if (blank) {
        // Not remembered: a blank session can't be reopened once closed, so it must never linger as a Closed row.
        blankIds.add(entry.sessionId);
        if (previous) {
          delete known[entry.sessionId];
          knownChanged = true;
        }
      } else if (!previous || previous.title !== title || previous.cwd !== entry.cwd || previous.closedAt !== undefined) {
        known[entry.sessionId] = { sessionId: entry.sessionId, title, cwd: entry.cwd, firstSeenAt };
        knownChanged = true;
      }

      const dismissedAt = dismissed[entry.sessionId];
      if (dismissedAt !== undefined) {
        if (!shouldUndismiss(entry, dismissedAt, reader.state.lastActivityAt)) {
          continue;
        }
        delete dismissed[entry.sessionId];
        dismissedChanged = true;
      }

      const status = describeStatus(entry.status, entry.waitingFor, agents.length, true);
      const since = entry.statusUpdatedAt ?? entry.updatedAt ?? entry.startedAt ?? now;
      const mode = resolveMode(reader.state, await this.modes.get(entry.sessionId), initialPermissionMode());
      (blank ? blankViews : views).push({
        sessionId: entry.sessionId,
        title,
        cwd: entry.cwd,
        pid: entry.pid,
        status,
        mode,
        since,
        firstSeenAt,
        agents,
        description: describeRow(status, agents.length, since, now, mode),
      });
    }

    // Blank sessions are interchangeable: show only the newest, which is the one Claude most likely still holds.
    const newestBlank = blankViews.sort((a, b) => b.firstSeenAt - a.firstSeenAt)[0];
    if (newestBlank) {
      views.push(newestBlank);
    }

    for (const session of Object.values(known)) {
      if (live.has(session.sessionId)) {
        continue;
      }
      if (session.title === BLANK_TITLE) {
        // Remembered by an earlier version; blank sessions can't be reopened.
        delete known[session.sessionId];
        knownChanged = true;
        continue;
      }
      const closedAt = session.closedAt ?? now;
      if (session.closedAt === undefined) {
        known[session.sessionId] = { ...session, closedAt };
        knownChanged = true;
      }
      if (now - closedAt > FORGET_CLOSED_AFTER_MS) {
        delete known[session.sessionId];
        knownChanged = true;
        if (session.sessionId in dismissed) {
          delete dismissed[session.sessionId];
          dismissedChanged = true;
        }
        continue;
      }
      if (dismissed[session.sessionId] !== undefined) {
        continue;
      }
      const status = describeStatus(undefined, undefined, 0, false);
      views.push({
        sessionId: session.sessionId,
        title: session.title,
        cwd: session.cwd,
        status,
        since: closedAt,
        firstSeenAt: session.firstSeenAt,
        agents: [],
        description: describeRow(status, 0, closedAt, now),
      });
    }

    views.sort(compareSessions);
    if (knownChanged) {
      await this.store.setKnown(known);
    }
    if (dismissedChanged) {
      await this.store.setDismissed(dismissed);
    }

    this.views = views;
    this.liveIds = new Set(live.keys());
    this.blankIds = blankIds;
    this.logIfChanged(views);
    const signature = JSON.stringify(
      views.map((v) => [v.sessionId, v.title, v.description, v.status.state, v.status.long, v.pid, v.agents.map((a) => a.agentId)]),
    );
    if (signature !== this.signature) {
      this.signature = signature;
      this.changeEmitter.fire();
    }
  }

  /** Writes the list to the "Claude Master" output channel whenever a status, title or agent count changes. */
  private logIfChanged(views: SessionView[]): void {
    const lines = views.map(
      (v) => `${v.status.short}${v.mode ? ` [${modeLabel(v.mode)}]` : ''}${v.agents.length > 0 ? ` (+${v.agents.length} agents)` : ''}: ${v.title}`,
    );
    const summary = lines.join('\n');
    if (summary !== this.lastLogged) {
      this.lastLogged = summary;
      this.log.info(`${views.length} session(s)${lines.map((l) => `\n  ${l}`).join('')}`);
    }
  }

  dispose(): void {
    clearInterval(this.pollTimer);
    if (this.scheduled) {
      clearTimeout(this.scheduled);
    }
    this.registry.dispose();
    this.ownership.dispose();
    this.changeEmitter.dispose();
  }
}
