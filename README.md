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

Run `/hud all` to open every pane at once (Tool calls, Tasks, Craft, KPIs, Next), or to close them all when they are all open.

Run `/hud tools` to open or close a side pane listing every tool call in the session: the tool, what it worked on, whether it succeeded, and the model's reason (the last line it wrote before the call). Calls are grouped by tool, and skills are listed under Skills, whether Claude used one or you typed `/name`. Each subagent gets its own lane with its type, its task, whether it's still running, and its calls.

Run `/hud tasks` to open or close a pane with your open ClickUp tasks, grouped by status with priority and due date. Press a task's number (or click it) to put it in your prompt, or click ↗ open to open it in your browser. It needs the ClickUp connector (in auto mode, such as the Desktop app, also allow `mcp__<server>__clickup_filter_tasks` and `mcp__<server>__clickup_resolve_assignees` in `permissions.allow`; the pane names the rules to add), refreshes every 5 minutes while open, and `r` refreshes it now.

Run `/hud craft` to open or close a pane with your active Craft tasks, grouped into overdue, today, later and no date. Press **✓ done** twice to mark a task done in Craft (it moves to the logbook); `u` undoes the last one. Clicking a task puts it in your prompt, and ↗ open opens it in the Craft app. It needs the Craft connector; in auto mode, also allow `mcp__<server>__craft_read` and `mcp__<server>__craft_write`.

Run `/hud kpi` to open your personal KPIs: prompts today against a daily goal, prompts per active hour, an hour-by-hour sparkline, this week by day with your share of the weekly limit, your streak of days at goal, and the pace of your weekly and 5-hour limits (where you'll end up by the reset, and how much a day is left to use the rest). Prompts are counted across all your sessions; only prompts you write count, not ones plugins or schedules submit. The band shows `✎ prompts/goal`.

When no session has had a prompt for a while during work hours, a toast and a soft chime nudge you; the toast names your next Craft task and suggests it in the prompt box.

- `/hud goal 40` sets the daily prompt goal (default 30)
- `/hud idle 45` sets the nudge after 45 idle minutes; `/hud idle off` turns it off (default 30)
- `/hud hours 9-19` sets work hours, Monday to Friday (default 9-19)
- `/hud sound off` silences the nudge's chime, `/hud sound on` brings it back, `/hud sound test` plays it (macOS)

Run `/hud next` for next-prompt suggestions. It reads the tail of your 10 most recently active sessions' transcripts (`~/.claude/projects`), keeps only the prompts you wrote and Claude's last reply, and asks Sonnet for the 3 to 5 most useful next prompts. Press a number to put one in your prompt; one from another project names its folder. Suggestions are kept for two hours (`r` makes new ones), and the idle nudge suggests the top one. Making suggestions spends a model call from your plan.

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
