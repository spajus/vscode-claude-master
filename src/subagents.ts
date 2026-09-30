import * as fs from 'fs';
import * as path from 'path';
import { AgentMeta, isAgentReportedDone, isFinishedAgentLine, parseAgentMeta, SubagentInfo, TranscriptState } from './core/model';

const META_SUFFIX = '.meta.json';
const MAX_TAIL_BYTES = 8 << 20;

/** Returns the last non-empty line of a file, reading backwards from the end in growing chunks. */
async function readLastLine(file: string, size: number): Promise<string | undefined> {
  const handle = await fs.promises.open(file, 'r');
  try {
    let length = Math.min(size, 64 << 10);
    for (;;) {
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, size - length);
      let end = buffer.length;
      while (end > 0 && (buffer[end - 1] === 0x0a || buffer[end - 1] === 0x0d)) {
        end--;
      }
      const start = buffer.lastIndexOf(0x0a, end - 1);
      if (start !== -1 || length === size) {
        return buffer.toString('utf8', start + 1, end);
      }
      if (length >= MAX_TAIL_BYTES) {
        return undefined;
      }
      length = Math.min(size, length * 4);
    }
  } finally {
    await handle.close();
  }
}

interface SessionAgents {
  metas: Map<string, AgentMeta>;
  /** Agents known to be over for good; never re-examined. */
  done: Set<string>;
  /** size:mtime of each running agent's transcript when its last line was checked, to skip re-reading it. */
  tails: Map<string, string>;
}

/**
 * Counts running subagents of a session. An agent counts as running only if its transcript was written
 * after the session process started, the transcript doesn't end with an assistant `end_turn`, and the
 * parent session's transcript hasn't reported it finished.
 */
export class SubagentTracker {
  private readonly sessions = new Map<string, SessionAgents>();

  forget(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  async running(sessionId: string, sessionDir: string, startedAt: number | undefined, transcript: TranscriptState): Promise<SubagentInfo[]> {
    let s = this.sessions.get(sessionId);
    if (!s) {
      s = { metas: new Map(), done: new Set(), tails: new Map() };
      this.sessions.set(sessionId, s);
    }
    const dir = path.join(sessionDir, 'subagents');
    let names: string[];
    try {
      names = await fs.promises.readdir(dir);
    } catch {
      return [];
    }

    const direct: AgentMeta[] = [];
    const nested: AgentMeta[] = [];
    for (const name of names) {
      if (!name.startsWith('agent-') || !name.endsWith(META_SUFFIX)) {
        continue;
      }
      const agentId = name.slice('agent-'.length, -META_SUFFIX.length);
      if (s.done.has(agentId)) {
        continue;
      }
      const meta = await this.loadMeta(s, dir, agentId);
      if (!meta) {
        continue;
      }
      if (meta.spawnDepth <= 1 && isAgentReportedDone(meta, transcript)) {
        s.done.add(agentId);
        continue;
      }
      const state = await this.examine(s, dir, meta, startedAt);
      if (state === 'running') {
        (meta.spawnDepth <= 1 ? direct : nested).push(meta);
      }
    }
    // Nested agents can't outlive the top-level agents that spawned them.
    const running = direct.length > 0 ? [...direct, ...nested] : direct;
    return running.map(({ agentId, agentType, description }) => ({ agentId, agentType, description }));
  }

  private async loadMeta(s: SessionAgents, dir: string, agentId: string): Promise<AgentMeta | undefined> {
    const cached = s.metas.get(agentId);
    if (cached) {
      return cached;
    }
    try {
      const meta = parseAgentMeta(agentId, JSON.parse(await fs.promises.readFile(path.join(dir, `agent-${agentId}${META_SUFFIX}`), 'utf8')));
      if (meta) {
        s.metas.set(agentId, meta);
      }
      return meta;
    } catch {
      return undefined; // possibly half-written; try again next time
    }
  }

  private async examine(s: SessionAgents, dir: string, meta: AgentMeta, startedAt: number | undefined): Promise<'running' | 'finished'> {
    const transcriptFile = path.join(dir, `agent-${meta.agentId}.jsonl`);
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(transcriptFile);
    } catch {
      // Launched but nothing written yet: running if it was created by the current process.
      try {
        const metaStat = await fs.promises.stat(path.join(dir, `agent-${meta.agentId}${META_SUFFIX}`));
        return startedAt === undefined || metaStat.mtimeMs >= startedAt - 1000 ? 'running' : this.markDone(s, meta);
      } catch {
        return this.markDone(s, meta);
      }
    }
    if (startedAt !== undefined && stat.mtimeMs < startedAt - 1000) {
      // Left over from before the session process (re)started; it can't be running.
      return this.markDone(s, meta);
    }
    const key = `${stat.size}:${stat.mtimeMs}`;
    if (s.tails.get(meta.agentId) === key) {
      return 'running';
    }
    let finished = false;
    try {
      const last = stat.size > 0 ? await readLastLine(transcriptFile, stat.size) : undefined;
      finished = last !== undefined && isFinishedAgentLine(last);
    } catch {
      finished = false;
    }
    if (finished) {
      return this.markDone(s, meta);
    }
    s.tails.set(meta.agentId, key);
    return 'running';
  }

  private markDone(s: SessionAgents, meta: AgentMeta): 'finished' {
    s.done.add(meta.agentId);
    s.tails.delete(meta.agentId);
    return 'finished';
  }
}
