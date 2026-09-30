import * as vscode from 'vscode';

/** What we remember about a session so it can still be listed as Closed after its process is gone. */
export interface KnownSession {
  sessionId: string;
  title: string;
  cwd: string;
  firstSeenAt: number;
  /** When the session's process was first seen gone; unset while it is live. */
  closedAt?: number;
}

export type KnownSessions = Record<string, KnownSession>;
/** sessionId → when it was removed from the list. */
export type DismissedSessions = Record<string, number>;

const KNOWN_KEY = 'claudeMaster.known';
const DISMISSED_KEY = 'claudeMaster.dismissed';

/** Per-workspace persistence (this window's sessions only). Getters return copies that are safe to mutate. */
export class SessionStore {
  constructor(private readonly memento: vscode.Memento) {}

  get known(): KnownSessions {
    return { ...this.memento.get<KnownSessions>(KNOWN_KEY, {}) };
  }

  get dismissed(): DismissedSessions {
    return { ...this.memento.get<DismissedSessions>(DISMISSED_KEY, {}) };
  }

  setKnown(value: KnownSessions): Thenable<void> {
    return this.memento.update(KNOWN_KEY, value);
  }

  setDismissed(value: DismissedSessions): Thenable<void> {
    return this.memento.update(DISMISSED_KEY, value);
  }
}
