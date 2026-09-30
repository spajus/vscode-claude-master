import * as fs from 'fs';
import * as path from 'path';
import { projectsDir } from './claudePaths';
import { applyTranscriptLine, newTranscriptState, TranscriptState } from './core/model';

const CHUNK_SIZE = 1 << 20;
const NEWLINE = 0x0a;

/** Finds `projects/<any>/<sessionId>.jsonl` without having to reproduce Claude's folder-name encoding. */
async function locateTranscript(sessionId: string): Promise<string | undefined> {
  let folders: string[];
  try {
    folders = await fs.promises.readdir(projectsDir());
  } catch {
    return undefined;
  }
  for (const folder of folders) {
    const candidate = path.join(projectsDir(), folder, `${sessionId}.jsonl`);
    try {
      await fs.promises.access(candidate);
      return candidate;
    } catch {
      // not in this folder
    }
  }
  return undefined;
}

/**
 * Follows one session's transcript. The file is append-only, so after the first full pass only
 * newly appended bytes are read. Tracks the title and which agents have finished.
 */
export class TranscriptReader {
  private file?: string;
  private offset = 0;
  private carry: Buffer = Buffer.alloc(0);
  private lastSize = -1;
  private lastMtime = -1;
  private reading = false;
  state: TranscriptState = newTranscriptState();

  constructor(readonly sessionId: string) {}

  /** `projects/<encoded-cwd>/<sessionId>`: holds `subagents/`. Known once the transcript was found. */
  get sessionDir(): string | undefined {
    return this.file?.slice(0, -'.jsonl'.length);
  }

  /** Reads anything new. Returns true if the state may have changed. */
  async update(): Promise<boolean> {
    if (this.reading) {
      return false;
    }
    this.reading = true;
    try {
      this.file ??= await locateTranscript(this.sessionId);
      if (!this.file) {
        return false;
      }
      let stat: fs.Stats;
      try {
        stat = await fs.promises.stat(this.file);
      } catch {
        this.file = undefined;
        return false;
      }
      if (stat.size === this.lastSize && stat.mtimeMs === this.lastMtime) {
        return false;
      }
      let changed = false;
      if (stat.size < this.offset) {
        // Rewritten rather than appended: start over.
        this.state = newTranscriptState();
        this.offset = 0;
        this.carry = Buffer.alloc(0);
        changed = true;
      }
      changed = (await this.readFrom(this.file, stat.size)) || changed;
      this.lastSize = stat.size;
      this.lastMtime = stat.mtimeMs;
      return changed;
    } finally {
      this.reading = false;
    }
  }

  private async readFrom(file: string, size: number): Promise<boolean> {
    let changed = false;
    const handle = await fs.promises.open(file, 'r');
    try {
      while (this.offset < size) {
        const buffer = Buffer.alloc(Math.min(CHUNK_SIZE, size - this.offset));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, this.offset);
        if (bytesRead === 0) {
          break;
        }
        this.offset += bytesRead;
        // Split on raw newline bytes so multi-byte UTF-8 characters are never cut in half.
        let data = Buffer.concat([this.carry, buffer.subarray(0, bytesRead)]);
        let newline = data.indexOf(NEWLINE);
        while (newline !== -1) {
          const line = data.toString('utf8', 0, newline);
          if (line.length > 0) {
            changed = applyTranscriptLine(this.state, line) || changed;
          }
          data = data.subarray(newline + 1);
          newline = data.indexOf(NEWLINE);
        }
        this.carry = Buffer.from(data);
      }
    } finally {
      await handle.close();
    }
    return changed;
  }
}
