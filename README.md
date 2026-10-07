# session-hud

A HUD band above the Claude Code prompt showing:

- git branch and number of changed files
- context window fill (with a toast at 85%)
- session cost
- the highest rate-limit usage
- tool call count and the most used tools
- how long the last turn took
- how long the prompt cache stays warm, and how many tokens the next send rewrites once it's cold

Run `/hud` to hide or show it.

Run `/hud tools` to open or close a side pane listing every tool call in the session: the tool, what it worked on, whether it succeeded, and the model's reason (the last line it wrote before the call). Calls are grouped by tool, and skills are listed under Skills, whether Claude used one or you typed `/name`. Each subagent gets its own lane with its type, its task, whether it's still running, and its calls.

Run `/hud tasks` to open or close a pane with your open ClickUp tasks, grouped by status with priority and due date. Press a task's number (or click it) to put it in your prompt, or click ↗ open to open it in your browser. It needs the ClickUp connector (in auto mode, such as the Desktop app, also allow `mcp__<server>__clickup_filter_tasks` and `mcp__<server>__clickup_resolve_assignees` in `permissions.allow`; the pane names the rules to add), refreshes every 5 minutes while open, and `r` refreshes it now.

Run `/hud craft` to open or close a pane with your active Craft tasks, grouped into overdue, today, later and no date. Press **✓ done** twice to mark a task done in Craft (it moves to the logbook); `u` undoes the last one. Clicking a task puts it in your prompt, and ↗ open opens it in the Craft app. It needs the Craft connector; in auto mode, also allow `mcp__<server>__craft_read` and `mcp__<server>__craft_write`.

Run `/hud update` to install the latest version from GitHub; it reloads plugins for you.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install session-hud --marketplace CorepanyDev/session-hud
```

Answer `y` to add the marketplace, then pick the user scope.

## Develop

```
claude plugin validate .
claude plugin test .
claude --plugin-dir .
```
