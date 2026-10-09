# Changelog

All notable changes to Claude Master are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.2.0] - 2026-10-09

### Added

- Each row shows how many background tasks (shells and monitors) are running, out of all the session has launched, e.g. `0/13 bg tasks`.

### Changed

- Agent counts show running out of launched, e.g. `1/3 agents`, and stay on the row once the agents finish.
- The status word is no longer repeated in the row: the icon shows it, and the tooltip spells it out.

## [0.1.0] - 2026-10-01

First public release.

- A dockable **Claude Sessions** view listing the Claude Code sessions running in the current VS Code window, with live status: Working, Permission / Input, N agents running, Idle, Closed.
- Each row shows the session's permission mode (`auto`, `plan`, `edits`, `ask`), the number of running subagents, and how long it has been in its current state.
- Click a row to switch the Claude Code sidebar to that session; closed sessions are resumed.
- The view's badge counts the sessions waiting for you.
- Remove sessions from the list one at a time or clear all Idle and Closed ones; a removed session comes back as soon as anything new happens in it.
- The **Claude Master** output channel logs every change in the list.

[Unreleased]: https://github.com/spajus/vscode-claude-master/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/spajus/vscode-claude-master/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/spajus/vscode-claude-master/releases/tag/v0.1.0
