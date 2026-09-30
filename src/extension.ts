import * as vscode from 'vscode';
import { SessionController } from './controller';
import { SessionView } from './core/model';
import { ClaudeModeStore } from './modeStore';
import { openSession, revealClaude } from './open';
import { SessionStore } from './sessionStore';
import { SessionTreeProvider } from './tree';

export function activate(context: vscode.ExtensionContext): void {
  const log = vscode.window.createOutputChannel('Claude Master', { log: true });
  const controller = new SessionController(
    new SessionStore(context.workspaceState),
    ClaudeModeStore.forClaudeExtension(context.globalStorageUri.fsPath),
    log,
  );
  const provider = new SessionTreeProvider(controller);
  const view = vscode.window.createTreeView('claudeMaster.sessions', { treeDataProvider: provider, canSelectMany: true });

  const updateBadge = (): void => {
    const waiting = controller.sessions.filter((s) => s.status.state === 'waiting').length;
    view.badge =
      waiting > 0
        ? { value: waiting, tooltip: waiting === 1 ? '1 Claude session is waiting for you' : `${waiting} Claude sessions are waiting for you` }
        : undefined;
  };

  context.subscriptions.push(
    log,
    controller,
    provider,
    view,
    controller.onDidChange(() => {
      provider.refresh();
      updateBadge();
    }),
    vscode.commands.registerCommand('claudeMaster.openSession', (arg?: SessionView | string) => {
      const sessionId = typeof arg === 'string' ? arg : (arg ?? view.selection[0])?.sessionId;
      if (!sessionId) {
        return undefined;
      }
      return controller.isBlank(sessionId) ? revealClaude(log) : openSession(sessionId, log);
    }),
    vscode.commands.registerCommand('claudeMaster.removeSession', (arg?: SessionView, selected?: SessionView[]) => {
      // From a multi-selection context menu VS Code passes (clicked, allSelected).
      const targets = arg && selected?.some((s) => s.sessionId === arg.sessionId) ? selected : arg ? [arg] : view.selection;
      return controller.remove(targets.map((t) => t.sessionId));
    }),
    vscode.commands.registerCommand('claudeMaster.clearInactive', () => controller.removeInactive()),
    vscode.commands.registerCommand('claudeMaster.restoreRemoved', () => controller.restoreRemoved()),
    vscode.commands.registerCommand('claudeMaster.refresh', () => controller.refresh(0)),
  );
}

export function deactivate(): void {}
