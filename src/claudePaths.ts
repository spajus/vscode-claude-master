import * as os from 'os';
import * as path from 'path';

/** Claude Code's config directory: `CLAUDE_CONFIG_DIR` if set, else `~/.claude`. */
export function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

/** One `<pid>.json` per running Claude process. */
export function sessionsDir(): string {
  return path.join(claudeConfigDir(), 'sessions');
}

/** Transcripts: `projects/<encoded-cwd>/<sessionId>.jsonl`. */
export function projectsDir(): string {
  return path.join(claudeConfigDir(), 'projects');
}
