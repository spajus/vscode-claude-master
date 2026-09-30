import * as fs from 'fs';
import * as path from 'path';
import { isUuid, parseStoredMode, StoredMode } from './core/model';

/**
 * Reads (never writes) the Claude extension's per-session permission-mode records:
 * `<globalStorage>/anthropic.claude-code/session-permission-modes/<sessionId>.json`, e.g. `{"mode":"auto","updatedAt":…}`.
 * Claude writes one when the user picks a mode in its UI, so it catches changes made between prompts.
 */
export class ClaudeModeStore {
  private readonly cache = new Map<string, { mtimeMs: number; value: StoredMode | undefined }>();

  constructor(private readonly dir: string) {}

  static forClaudeExtension(ownGlobalStorage: string): ClaudeModeStore {
    return new ClaudeModeStore(path.join(path.dirname(ownGlobalStorage), 'anthropic.claude-code', 'session-permission-modes'));
  }

  async get(sessionId: string): Promise<StoredMode | undefined> {
    if (!isUuid(sessionId)) {
      return undefined;
    }
    const file = path.join(this.dir, `${sessionId}.json`);
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(file);
    } catch {
      this.cache.delete(sessionId);
      return undefined;
    }
    const cached = this.cache.get(sessionId);
    if (cached && cached.mtimeMs === stat.mtimeMs) {
      return cached.value;
    }
    try {
      const value = parseStoredMode(JSON.parse(await fs.promises.readFile(file, 'utf8')));
      this.cache.set(sessionId, { mtimeMs: stat.mtimeMs, value });
      return value;
    } catch {
      return cached?.value; // possibly mid-write; keep the previous value
    }
  }

  forget(sessionId: string): void {
    this.cache.delete(sessionId);
  }
}
