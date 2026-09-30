import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { sessionsDir } from './claudePaths';
import { parseRegistryEntry, RegistryEntry } from './core/model';
import { isAlive, OwnershipChecker } from './processInfo';

/** Reads `~/.claude/sessions/*.json` and returns the live Claude sessions that belong to this window. */
export class SessionRegistry implements vscode.Disposable {
  private watcher?: fs.FSWatcher;
  /** Last successfully parsed content per file, so a half-written file doesn't make a session flicker. */
  private readonly lastGood = new Map<string, RegistryEntry>();

  constructor(
    private readonly ownership: OwnershipChecker,
    private readonly onDirectoryChanged: () => void,
  ) {
    this.ensureWatcher();
  }

  private ensureWatcher(): void {
    if (this.watcher) {
      return;
    }
    try {
      this.watcher = fs.watch(sessionsDir(), () => this.onDirectoryChanged());
      this.watcher.on('error', () => {
        this.watcher?.close();
        this.watcher = undefined;
      });
    } catch {
      // Directory doesn't exist yet (Claude never ran); polling covers it and we retry on the next scan.
      this.watcher = undefined;
    }
  }

  async scan(): Promise<RegistryEntry[]> {
    this.ensureWatcher();
    const dir = sessionsDir();
    let names: string[];
    try {
      names = await fs.promises.readdir(dir);
    } catch {
      names = [];
    }
    // `<pid>.json` only; `<pid>.<hash>.key` files hold peer-messaging secrets and are never read.
    const files = names.filter((name) => /^\d+\.json$/.test(name));
    const entries: RegistryEntry[] = [];
    for (const name of files) {
      let entry: RegistryEntry | undefined;
      try {
        entry = parseRegistryEntry(JSON.parse(await fs.promises.readFile(path.join(dir, name), 'utf8')));
      } catch {
        entry = undefined;
      }
      if (entry) {
        this.lastGood.set(name, entry);
      } else {
        entry = this.lastGood.get(name);
      }
      if (entry) {
        entries.push(entry);
      }
    }
    for (const name of this.lastGood.keys()) {
      if (!files.includes(name)) {
        this.lastGood.delete(name);
      }
    }

    // Filter synchronously so all unknown pids go into a single process lookup.
    const bySession = new Map<string, RegistryEntry>();
    for (const entry of entries) {
      if (entry.entrypoint !== undefined && entry.entrypoint !== 'claude-vscode') {
        continue;
      }
      if (!isAlive(entry.pid) || this.ownership.isOwned(entry) !== true) {
        continue;
      }
      const previous = bySession.get(entry.sessionId);
      if (!previous || (entry.startedAt ?? 0) > (previous.startedAt ?? 0)) {
        bySession.set(entry.sessionId, entry);
      }
    }
    return [...bySession.values()];
  }

  dispose(): void {
    this.watcher?.close();
  }
}
