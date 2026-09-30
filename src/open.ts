import * as vscode from 'vscode';
import { isUuid } from './core/model';

const CLAUDE_EXTENSION_ID = 'anthropic.claude-code';

/**
 * Claude only switches the session of its sidebar view (instead of opening a new editor tab) when
 * `claudeCode.preferredLocation` is "sidebar". Claude itself treats that setting as "where Claude was
 * last used": its "Open in Side Bar" command sets it to "sidebar" and opening a tab sets it back to "panel".
 * Sets it the same way, at whichever level currently decides the value.
 */
async function preferSidebar(log: vscode.LogOutputChannel): Promise<void> {
  const config = vscode.workspace.getConfiguration('claudeCode');
  if (config.get<string>('preferredLocation') === 'sidebar') {
    return;
  }
  const inspected = config.inspect<string>('preferredLocation');
  const target = inspected?.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
  const applied = new Promise<void>((resolve) => {
    const timeout = setTimeout(() => done(), 1000);
    const listener = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('claudeCode.preferredLocation')) {
        done();
      }
    });
    function done(): void {
      clearTimeout(timeout);
      listener.dispose();
      resolve();
    }
  });
  await config.update('preferredLocation', 'sidebar', target);
  await applied;
  log.info('Set claudeCode.preferredLocation to "sidebar" so sessions switch inside the Claude sidebar view.');
}

/** Activates Claude Code. Returns false, after telling the user, when it isn't installed. */
async function activateClaude(): Promise<boolean> {
  const claude = vscode.extensions.getExtension(CLAUDE_EXTENSION_ID);
  if (!claude) {
    void vscode.window.showErrorMessage('The Claude Code extension (anthropic.claude-code) is not installed.');
    return false;
  }
  if (!claude.isActive) {
    await claude.activate();
  }
  return true;
}

/** The view Claude's own sidebar switching focuses: the Secondary Side Bar one from VS Code 1.106 on. */
function claudeSidebarView(): string {
  const [major = 0, minor = 0] = vscode.version.split('.').map(Number);
  return major > 1 || (major === 1 && minor >= 106) ? 'claudeVSCodeSidebarSecondary' : 'claudeVSCodeSidebar';
}

/**
 * Shows Claude's sidebar view without switching its session. Used for a session with no prompt yet: Claude's view
 * holds it without an id until the first prompt, so asking Claude to switch to it by id finds nothing and makes
 * Claude start yet another blank session.
 */
export async function revealClaude(log: vscode.LogOutputChannel): Promise<void> {
  try {
    if (!(await activateClaude())) {
      return;
    }
    await vscode.commands.executeCommand(`${claudeSidebarView()}.focus`);
    vscode.window.setStatusBarMessage("Claude Code can't switch to an Untitled session from here. If another session is showing, pick it in Claude's session list.", 8000);
  } catch (err) {
    log.error('Showing the Claude view failed:', err instanceof Error ? err.message : String(err));
  }
}

/**
 * Switches Claude's sidebar view to the session. If the session is open in its own Claude editor tab,
 * Claude reveals that tab instead.
 */
export async function openSession(sessionId: string, log: vscode.LogOutputChannel): Promise<void> {
  if (!isUuid(sessionId)) {
    log.warn(`Refusing to open malformed session id: ${sessionId}`);
    return;
  }
  try {
    if (!(await activateClaude())) {
      return;
    }
    await preferSidebar(log);
    await vscode.commands.executeCommand(
      'claude-vscode.editor.open',
      sessionId,
      undefined,
      undefined,
      undefined,
      undefined,
      { programmatic: 'honor-preferred-location' },
    );
  } catch (err) {
    log.error('Switching Claude to the session failed:', err instanceof Error ? err.message : String(err));
    void vscode.window.showErrorMessage(`Couldn't switch Claude Code to this session: ${err instanceof Error ? err.message : String(err)}`);
  }
}
