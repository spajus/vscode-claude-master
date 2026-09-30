import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { procStartMatches, RegistryEntry } from './core/model';

interface ProcInfo {
  ppid: number;
  creationFileTime: string;
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function powershellPath(): string {
  const candidate = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return fs.existsSync(candidate) ? candidate : 'powershell.exe';
}

/** One batched CIM query for parent pid and creation time. Resolves undefined if PowerShell itself failed. */
function queryProcesses(pids: number[]): Promise<Map<number, ProcInfo> | undefined> {
  const filter = pids.map((pid) => `ProcessId=${Math.trunc(pid)}`).join(' OR ');
  const script =
    `Get-CimInstance Win32_Process -Filter '${filter}' | ForEach-Object { ` +
    `'{0}|{1}|{2}' -f $_.ProcessId, $_.ParentProcessId, $_.CreationDate.ToFileTimeUtc() }`;
  return new Promise((resolve) => {
    execFile(
      powershellPath(),
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, timeout: 20_000 },
      (err, stdout) => {
        if (err) {
          resolve(undefined);
          return;
        }
        const result = new Map<number, ProcInfo>();
        for (const line of stdout.split(/\r?\n/)) {
          const [pid, ppid, fileTime] = line.trim().split('|');
          if (pid && ppid && /^\d+$/.test(fileTime ?? '')) {
            result.set(Number(pid), { ppid: Number(ppid), creationFileTime: fileTime });
          }
        }
        resolve(result);
      },
    );
  });
}

function normalizePath(p: string): string {
  const resolved = path.resolve(p);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isInWorkspace(cwd: string): boolean {
  const target = normalizePath(cwd);
  return (vscode.workspace.workspaceFolders ?? []).some((folder) => {
    const root = normalizePath(folder.uri.fsPath);
    return target === root || target.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
  });
}

/**
 * Decides whether a registry entry is a Claude process started by this window.
 *
 * On Windows the Claude extension spawns `claude.exe` directly from the extension host we also run in,
 * so the process's parent pid equals our `process.pid`. Matching the creation time against `procStart`
 * also rejects registry files left behind by dead processes whose pid was reused.
 * Elsewhere (or if PowerShell fails) this falls back to "cwd is inside one of this window's folders".
 */
export class OwnershipChecker implements vscode.Disposable {
  private readonly cache = new Map<string, boolean>();
  private readonly pending = new Map<string, { pid: number; procStart: string }>();
  private flushTimer?: NodeJS.Timeout;
  private queryInFlight = false;
  private retryAfter = 0;
  private readonly resolvedEmitter = new vscode.EventEmitter<void>();
  /** Fires when previously pending entries were resolved. */
  readonly onDidResolve = this.resolvedEmitter.event;

  constructor(private readonly log: vscode.LogOutputChannel) {}

  /** true / false, or undefined while the answer is still being looked up. */
  isOwned(entry: RegistryEntry): boolean | undefined {
    if (process.platform !== 'win32' || !entry.procStart) {
      return isInWorkspace(entry.cwd);
    }
    const key = `${entry.pid}:${entry.procStart}`;
    const cached = this.cache.get(key);
    if (cached !== undefined) {
      return cached;
    }
    if (Date.now() < this.retryAfter) {
      return isInWorkspace(entry.cwd);
    }
    this.pending.set(key, { pid: entry.pid, procStart: entry.procStart });
    this.flushTimer ??= setTimeout(() => void this.flush(), 0);
    return undefined;
  }

  private async flush(): Promise<void> {
    this.flushTimer = undefined;
    if (this.queryInFlight || this.pending.size === 0) {
      return;
    }
    this.queryInFlight = true;
    const batch = new Map(this.pending);
    this.pending.clear();
    try {
      const info = await queryProcesses([...new Set([...batch.values()].map((b) => b.pid))]);
      if (!info) {
        this.log.warn('Process lookup via PowerShell failed; falling back to workspace-folder matching for 30s.');
        this.retryAfter = Date.now() + 30_000;
      } else {
        for (const [key, { pid, procStart }] of batch) {
          const proc = info.get(pid);
          this.cache.set(key, !!proc && proc.ppid === process.pid && procStartMatches(procStart, proc.creationFileTime));
        }
      }
    } finally {
      this.queryInFlight = false;
    }
    if (this.pending.size > 0) {
      this.flushTimer ??= setTimeout(() => void this.flush(), 0);
    }
    this.resolvedEmitter.fire();
  }

  dispose(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
    }
    this.resolvedEmitter.dispose();
  }
}
