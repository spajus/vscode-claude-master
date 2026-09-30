import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  applyTranscriptLine,
  compareSessions,
  describeRow,
  describeStatus,
  formatAge,
  isAgentReportedDone,
  isBlankSession,
  isFinishedAgentLine,
  modeLabel,
  newTranscriptState,
  parseAgentMeta,
  parseRegistryEntry,
  pickTitle,
  procStartMatches,
  resolveMode,
  SessionView,
  shouldUndismiss,
} from '../core/model';

const SID = 'ab603973-66e8-471f-8421-4396387cb0b8';

test('parseRegistryEntry accepts a real entry and rejects junk', () => {
  const e = parseRegistryEntry({
    pid: 55360,
    sessionId: SID,
    cwd: 'd:\\Gamedev\\x',
    procStart: '134352187722821355',
    status: 'busy',
    entrypoint: 'claude-vscode',
    statusUpdatedAt: 1790745287666,
  });
  assert.equal(e?.pid, 55360);
  assert.equal(e?.status, 'busy');
  assert.equal(parseRegistryEntry({ pid: '1', sessionId: SID, cwd: 'x' }), undefined);
  assert.equal(parseRegistryEntry({ pid: 1, sessionId: '../etc', cwd: 'x' }), undefined);
  assert.equal(parseRegistryEntry(null), undefined);
});

test('procStartMatches tolerates rounding but not pid reuse', () => {
  assert.ok(procStartMatches('134352187722821355', '134352187722821350'));
  assert.ok(!procStartMatches('134352187722821355', '134343018494394290'));
  assert.ok(!procStartMatches('garbage', '134343018494394290'));
});

test('describeStatus maps registry states', () => {
  assert.equal(describeStatus('busy', undefined, 0, true).short, 'Working');
  assert.equal(describeStatus('waiting', 'permission prompt', 0, true).short, 'Permission');
  assert.equal(describeStatus('waiting', 'input needed', 0, true).short, 'Input');
  assert.equal(describeStatus('waiting', 'plan approval', 0, true).short, 'Plan approval');
  assert.equal(describeStatus('idle', undefined, 0, true).state, 'idle');
  assert.equal(describeStatus('idle', undefined, 2, true).state, 'agents');
  assert.equal(describeStatus('busy', undefined, 0, false).state, 'closed');
  assert.equal(describeStatus('sleeping', undefined, 0, true).state, 'unknown');
});

test('describeRow is compact', () => {
  const now = 10 * 60_000;
  assert.equal(describeRow(describeStatus('busy', undefined, 2, true), 2, now - 3 * 60_000, now), 'Working · 2 agents · 3m');
  assert.equal(describeRow(describeStatus('idle', undefined, 1, true), 1, now, now), '1 agent running · now');
  assert.equal(describeRow(describeStatus('idle', undefined, 0, true), 0, now - 30_000, now), 'Idle · now');
  assert.equal(formatAge(3 * 3600_000), '3h');
  assert.equal(formatAge(50 * 3600_000), '2d');
});

function view(id: string, state: 'busy' | 'waiting' | 'idle' | 'closed', firstSeenAt: number): SessionView {
  const status = state === 'closed' ? describeStatus(undefined, undefined, 0, false) : describeStatus(state, 'input needed', 0, true);
  return { sessionId: id, title: id, cwd: '', status, since: 0, firstSeenAt, agents: [], description: '' };
}

test('compareSessions puts waiting first and keeps groups stable', () => {
  const sorted = [view('a', 'idle', 1), view('b', 'closed', 5), view('c', 'busy', 2), view('d', 'waiting', 0), view('e', 'busy', 3)].sort(
    compareSessions,
  );
  assert.deepEqual(
    sorted.map((v) => v.sessionId),
    ['d', 'e', 'c', 'a', 'b'],
  );
});

test('shouldUndismiss only on new activity after removal', () => {
  assert.ok(!shouldUndismiss({ status: 'idle', statusUpdatedAt: 200 }, 100));
  assert.ok(!shouldUndismiss({ status: 'busy', statusUpdatedAt: 50 }, 100));
  assert.ok(shouldUndismiss({ status: 'busy', statusUpdatedAt: 200 }, 100));
  assert.ok(shouldUndismiss({ status: 'waiting', statusUpdatedAt: 200 }, 100));
  // A turn that started and finished between polls is only visible in the transcript.
  assert.ok(shouldUndismiss({ status: 'idle', statusUpdatedAt: 200 }, 100, 150));
  assert.ok(!shouldUndismiss({ status: 'idle', statusUpdatedAt: 200 }, 100, 90));
});

test('lastActivityAt follows timestamped lines only', () => {
  const s = newTranscriptState();
  applyTranscriptLine(s, JSON.stringify({ type: 'assistant', message: { content: [] }, timestamp: '2026-09-30T08:41:44.602Z' }));
  assert.equal(s.lastActivityAt, Date.parse('2026-09-30T08:41:44.602Z'));
  // Written when a session is resumed or closed: no timestamp, not activity.
  applyTranscriptLine(s, JSON.stringify({ type: 'cost-state', sessionId: SID }));
  applyTranscriptLine(s, JSON.stringify({ type: 'last-prompt', lastPrompt: 'hi', sessionId: SID }));
  assert.equal(s.lastActivityAt, Date.parse('2026-09-30T08:41:44.602Z'));
  // Nested timestamps come first; the line's own one is last.
  const attachment = { type: 'attachment', attachment: { type: 'x', files: [{ timestamp: '2026-09-30T09:00:00.000Z' }] }, timestamp: '2026-09-30T08:50:00.000Z' };
  applyTranscriptLine(s, JSON.stringify(attachment));
  assert.equal(s.lastActivityAt, Date.parse('2026-09-30T08:50:00.000Z'));
  // Quoted in message text (escaped quotes) it isn't a key.
  applyTranscriptLine(s, JSON.stringify({ type: 'user', message: { content: 'see "timestamp":"2027-01-01T00:00:00Z"' } }));
  assert.equal(s.lastActivityAt, Date.parse('2026-09-30T08:50:00.000Z'));
});

test('pickTitle priority', () => {
  assert.equal(pickTitle({ name: 'proj-44', nameSource: 'derived', aiTitle: 'Fix fades' }), 'Fix fades');
  assert.equal(pickTitle({ name: 'My tab', nameSource: 'user', aiTitle: 'Fix fades' }), 'My tab');
  assert.equal(pickTitle({ customTitle: 'Renamed', aiTitle: 'Fix fades' }), 'Renamed');
  assert.equal(pickTitle({ name: 'proj-44', nameSource: 'derived', lastPrompt: 'do\nthe thing' }), 'do the thing');
  assert.equal(pickTitle({ name: 'proj-44', nameSource: 'derived' }), 'Untitled');
  assert.equal(pickTitle({}), 'Untitled');
});

test('applyTranscriptLine tracks titles and finished agents', () => {
  const s = newTranscriptState();
  assert.ok(applyTranscriptLine(s, JSON.stringify({ type: 'ai-title', aiTitle: 'First', sessionId: SID })));
  assert.ok(applyTranscriptLine(s, JSON.stringify({ type: 'ai-title', aiTitle: 'Second', sessionId: SID })));
  assert.equal(s.aiTitle, 'Second');
  assert.ok(!applyTranscriptLine(s, JSON.stringify({ type: 'assistant', message: { content: [] } })));

  // Background agent: the immediate ack is not completion; the task notification is.
  const ack = { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_bg', content: [{ type: 'text', text: 'Async agent launched successfully.' }] }] } };
  assert.ok(!applyTranscriptLine(s, JSON.stringify(ack)));
  assert.ok(!s.completedToolUseIds.has('toolu_bg'));
  const notification = '<task-notification>\n<task-id>a22bb</task-id>\n<tool-use-id>toolu_bg</tool-use-id>\n<status>completed</status>\n</task-notification>';
  assert.ok(applyTranscriptLine(s, JSON.stringify({ type: 'queue-operation', operation: 'enqueue', content: notification })));
  assert.ok(s.completedAgentIds.has('a22bb'));

  // Foreground agent: a real tool_result is completion.
  const result = { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_fg', content: 'Report text' }] } };
  assert.ok(applyTranscriptLine(s, JSON.stringify(result)));
  assert.ok(s.completedToolUseIds.has('toolu_fg'));

  // Notification text quoted inside an unrelated message doesn't count.
  const quoted = { type: 'user', message: { content: 'look at this: <task-notification><task-id>zzz</task-id>' } };
  assert.ok(!applyTranscriptLine(s, JSON.stringify(quoted)));
  assert.ok(!s.completedAgentIds.has('zzz'));
  assert.ok(!applyTranscriptLine(s, '{not json "ai-title"'));
});

test('permission mode follows prompts and mode-change attachments', () => {
  const s = newTranscriptState();
  const prompt = (mode: string, ts: string) =>
    JSON.stringify({ type: 'user', permissionMode: mode, timestamp: ts, message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } });
  const attachment = (type: string, ts: string) => JSON.stringify({ type: 'attachment', attachment: { type }, timestamp: ts });

  applyTranscriptLine(s, prompt('plan', '2026-09-30T05:00:00.000Z'));
  applyTranscriptLine(s, attachment('plan_mode', '2026-09-30T05:00:01.000Z'));
  assert.equal(s.mode, 'plan');
  // Plan approved into auto.
  applyTranscriptLine(s, attachment('plan_mode_exit', '2026-09-30T05:10:00.000Z'));
  assert.equal(s.mode, undefined);
  applyTranscriptLine(s, attachment('auto_mode', '2026-09-30T05:10:00.000Z'));
  assert.equal(s.mode, 'auto');
  assert.equal(s.modeAt, Date.parse('2026-09-30T05:10:00.000Z'));
  // An exit for a mode we're not in changes nothing.
  assert.ok(!applyTranscriptLine(s, attachment('plan_mode_exit', '2026-09-30T05:11:00.000Z')));
  assert.equal(s.mode, 'auto');
  applyTranscriptLine(s, prompt('acceptEdits', '2026-09-30T05:20:00.000Z'));
  assert.equal(s.mode, 'acceptEdits');

  // Claude's store wins only if the user picked a mode after the last transcript signal.
  assert.equal(resolveMode(s, { mode: 'plan', updatedAt: Date.parse('2026-09-30T05:30:00.000Z') }), 'plan');
  assert.equal(resolveMode(s, { mode: 'plan', updatedAt: Date.parse('2026-09-30T05:15:00.000Z') }), 'acceptEdits');
  assert.equal(resolveMode(s, { updatedAt: Date.parse('2026-09-30T05:30:00.000Z') }), 'acceptEdits');
  assert.equal(resolveMode(s, undefined), 'acceptEdits');

  // No prompt yet: Claude's initial mode, unless the user already picked one.
  const fresh = newTranscriptState();
  assert.equal(resolveMode(fresh, undefined, 'acceptEdits'), 'acceptEdits');
  assert.equal(resolveMode(fresh, { mode: 'auto', updatedAt: 1 }, 'acceptEdits'), 'auto');
  // After a plan exit the mode is unknown, not the initial mode.
  const exited = newTranscriptState();
  applyTranscriptLine(exited, attachment('plan_mode', '2026-09-30T05:00:00.000Z'));
  applyTranscriptLine(exited, attachment('plan_mode_exit', '2026-09-30T05:01:00.000Z'));
  assert.equal(resolveMode(exited, undefined, 'acceptEdits'), undefined);
});

test('blank sessions: nothing has happened yet', () => {
  const s = newTranscriptState();
  assert.ok(isBlankSession(s, { nameSource: 'derived' }));
  assert.ok(!isBlankSession(s, { nameSource: 'user' }), 'a renamed session is not blank');
  const prompt = JSON.stringify({ type: 'user', permissionMode: 'auto', timestamp: '2026-09-30T05:00:00.000Z', message: { content: 'hi' } });
  assert.ok(applyTranscriptLine(s, prompt));
  assert.ok(s.hasPrompt);
  assert.ok(!isBlankSession(s, { nameSource: 'derived' }));
  assert.ok(!isBlankSession({ hasPrompt: false, aiTitle: 'Fix fades' }, {}));
});

test('mode labels in the row', () => {
  const now = 10 * 60_000;
  assert.equal(describeRow(describeStatus('busy', undefined, 2, true), 2, now - 3 * 60_000, now, 'auto'), 'Working · auto · 2 agents · 3m');
  assert.equal(describeRow(describeStatus('idle', undefined, 0, true), 0, now, now, 'acceptEdits'), 'Idle · edits · now');
  assert.equal(describeRow(describeStatus('idle', undefined, 2, true), 2, now, now, 'plan'), '2 agents running · plan · now');
  assert.equal(modeLabel('default'), 'ask');
  assert.equal(modeLabel('somethingNew'), 'somethingNew');
  assert.equal(modeLabel(undefined), undefined);
});

test('agent completion rules', () => {
  const s = newTranscriptState();
  const bg = parseAgentMeta('a1', { agentType: 'Explore', description: 'x', toolUseId: 'toolu_1', spawnDepth: 1, requestShape: 'background' })!;
  const fg = parseAgentMeta('a2', { agentType: 'Explore', description: 'y', toolUseId: 'toolu_2', spawnDepth: 1 })!;
  s.completedToolUseIds.add('toolu_1');
  assert.ok(!isAgentReportedDone(bg, s), 'background agents are not finished by their launch tool_result');
  s.completedAgentIds.add('a1');
  assert.ok(isAgentReportedDone(bg, s));
  assert.ok(!isAgentReportedDone(fg, s));
  s.completedToolUseIds.add('toolu_2');
  assert.ok(isAgentReportedDone(fg, s));

  assert.ok(isFinishedAgentLine(JSON.stringify({ type: 'assistant', message: { stop_reason: 'end_turn' } })));
  assert.ok(!isFinishedAgentLine(JSON.stringify({ type: 'assistant', message: { stop_reason: 'tool_use' } })));
  assert.ok(!isFinishedAgentLine(JSON.stringify({ type: 'user', message: {} })));
  assert.ok(!isFinishedAgentLine('{"type":"assistant","message":{"stop_re'));
});
