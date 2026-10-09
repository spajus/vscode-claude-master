import * as vscode from 'vscode';
import { SessionController } from './controller';
import { modeName, SessionView } from './core/model';

function buildTooltip(v: SessionView, blank: boolean): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.appendMarkdown('**');
  md.appendText(v.title);
  md.appendMarkdown('**\n\n');
  if (blank) {
    md.appendText("No prompt yet. Claude Code can't be switched to such a session from outside, so clicking only shows the Claude view.");
    md.appendMarkdown('\n\n');
  }
  md.appendText(`${v.status.long} since ${new Date(v.since).toLocaleString()}`);
  md.appendMarkdown('\n\n');
  if (v.mode) {
    md.appendText(`Mode: ${modeName(v.mode)}`);
    md.appendMarkdown('\n\n');
  }
  if (v.agentTotal > 0) {
    md.appendText(`Agents: ${v.agents.length} running, ${v.agentTotal} launched in this session${v.agents.length > 0 ? ':' : ''}`);
    md.appendMarkdown('\n');
    for (const agent of v.agents) {
      md.appendMarkdown('- ');
      md.appendText(agent.description ? `${agent.agentType}: ${agent.description}` : agent.agentType);
      md.appendMarkdown('\n');
    }
    md.appendMarkdown('\n');
  }
  if (v.backgroundTasks.total > 0) {
    md.appendText(`Background tasks (shells and monitors): ${v.backgroundTasks.running} running, ${v.backgroundTasks.total} launched in this session`);
    md.appendMarkdown('\n\n');
  }
  md.appendMarkdown('---\n\n');
  md.appendText(v.cwd);
  md.appendMarkdown('\n\n');
  md.appendText(v.pid !== undefined ? `Session ${v.sessionId} · PID ${v.pid}` : `Session ${v.sessionId}`);
  return md;
}

/** Flat, one-row-per-session list. */
export class SessionTreeProvider implements vscode.TreeDataProvider<SessionView> {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changeEmitter.event;

  constructor(private readonly controller: SessionController) {}

  refresh(): void {
    this.changeEmitter.fire();
  }

  getChildren(element?: SessionView): SessionView[] {
    return element ? [] : [...this.controller.sessions];
  }

  getTreeItem(v: SessionView): vscode.TreeItem {
    const item = new vscode.TreeItem(v.title, vscode.TreeItemCollapsibleState.None);
    item.id = v.sessionId;
    item.description = v.description;
    // The row shows the status only as an icon, so screen readers need it spelled out.
    item.accessibilityInformation = { label: `${v.title}, ${v.status.short}, ${v.description}` };
    item.iconPath = new vscode.ThemeIcon(v.status.icon, v.status.color ? new vscode.ThemeColor(v.status.color) : undefined);
    item.tooltip = buildTooltip(v, this.controller.isBlank(v.sessionId));
    item.contextValue = `session.${v.status.state}`;
    item.command = { command: 'claudeMaster.openSession', title: 'Open Session', arguments: [v] };
    return item;
  }

  dispose(): void {
    this.changeEmitter.dispose();
  }
}
