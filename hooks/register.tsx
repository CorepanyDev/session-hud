import type { AgentStatus, EngineInterface, Register } from 'claude-code'

type Git = { branch: string; dirty: number } | null
type Call = {
  id: string
  tool: string
  target: string
  why: string
  agentId?: string
  state: 'running' | 'done' | 'error'
  // For skills: whether Claude called it through the Skill tool or you typed /name
  by?: 'claude' | 'you'
}
type Group = { name: string; calls: Call[]; last: number }
// One subagent: what it is, what it was asked, and where it stands
type Lane = { id: string; type: string; description: string; status: AgentStatus; last: number }
type Section =
  | { kind: 'group'; group: Group; recent: Call[] }
  | { kind: 'lane'; lane: Lane; count: number; recent: Call[] }
  | { kind: 'heading'; text: string }

const PANE = 'hud-tools'
const TASKS_PANE = 'hud-tasks'
const CLICKUP = 'claude.ai Clickup'
const CRAFT_PANE = 'hud-craft'
const CRAFT = 'claude.ai Craft'

// One of your active Craft tasks
type CraftTask = { id: string; text: string; project: string; schedule: string; deadline: string; where: string }

// One ClickUp task assigned to you
type Task = { id: string; name: string; status: string; url: string; priority: string | null; due: number | null; list: string }

// Green under 60%, yellow under 85%, red above
const levelColor = (percent: number) => (percent >= 85 ? 'red' : percent >= 60 ? 'yellow' : 'green')

// A ten-cell meter such as ▰▰▰▰▱▱▱▱▱▱
const meter = (percent: number) => {
  const filled = Math.round(Math.min(100, Math.max(0, percent)) / 10)
  return '▰'.repeat(filled) + '▱'.repeat(10 - filled)
}

const formatSeconds = (seconds: number) =>
  seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, '0')}s`

let isHidden = false
let git: Git = null
let tools = 0
const byTool = new Map<string, number>()
let turnStartedAt = 0
let lastTurnSeconds: number | null = null
let hasWarnedContext = false
let calls: Call[] = []
const lanes = new Map<string, Lane>()
let activity = 0
// When the main loop last sent a request, and the cache lifetime once a request has shown it
let lastRequestAt: number | null = null
let learnedTtlMs: number | null = null

const MINUTE = 60_000
const HOUR = 60 * MINUTE

const isActive = (status: AgentStatus) => status === 'pending' || status === 'running' || status === 'waiting'

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim()

// What the call works on: its own description when it has one, else its main argument
const targetOf = (e: Record<string, unknown>) => {
  for (const key of ['description', 'command', 'file_path', 'notebook_path', 'pattern', 'url', 'query', 'skill', 'prompt']) {
    const value = e[key]
    if (typeof value === 'string' && value.trim() !== '') return oneLine(value)
  }
  return ''
}

// The model's reason: the last line of text it wrote before the call, in this turn
async function explain($: EngineInterface, id: string, agentId: string | undefined) {
  try {
    const messages = await $.session.messages(agentId === undefined ? {} : { agentId })
    if ('deny' in messages) return ''
    let at = messages.findIndex(m => m.role === 'assistant' && m.toolUses.some(u => u.tool_use_id === id))
    if (at === -1) at = messages.length - 1
    for (let i = at; i >= 0; i--) {
      const m = messages[i]
      if (m === undefined) continue
      if (m.role === 'user' && m.toolResults === undefined) break
      if (m.role === 'assistant' && m.text.trim() !== '') {
        const lines = m.text.split('\n').map(oneLine).filter(line => line !== '')
        return lines.at(-1) ?? ''
      }
    }
  } catch {}
  return ''
}

// The pane's heading for a tool: skills together, MCP tools as server: tool
const groupOf = (tool: string) => {
  if (tool === 'Skill') return 'Skills'
  const mcp = /^mcp__(.+?)__(.+)$/.exec(tool)
  return mcp === null ? tool : `${mcp[1]}: ${mcp[2]}`
}

// Calls grouped by tool, the group used most recently first
const groupCalls = (list: Call[]) => {
  const groups = new Map<string, Group>()
  list.forEach((call, at) => {
    const name = groupOf(call.tool)
    const group = groups.get(name) ?? { name, calls: [], last: 0 }
    group.calls.push(call)
    group.last = at
    groups.set(name, group)
  })
  return [...groups.values()].sort((a, b) => b.last - a.last)
}

let skillSeq = 0

let tasks: Task[] = []
let tasksState: 'never' | 'loading' | 'ready' | 'error' = 'never'
let tasksError = ''
let tasksAt = 0

// The JSON a ClickUp tool answers with, from its first text block
const mcpJson = (result: { content: { type: string; text?: string }[]; isError: boolean }) => {
  const text = result.content.find(block => block.type === 'text')?.text ?? ''
  if (result.isError) throw new Error(text || 'ClickUp returned an error')
  return JSON.parse(text) as Record<string, unknown>
}

// The ClickUp connector's server: found by its tools, since each app names it its own way
let mcpServersSeen: string[] = []

// A connector's server, found by one of its tools, since each app names it its own way
async function findServer($: EngineInterface, toolName: string, fallback: string) {
  const seen = new Set<string>()
  try {
    for (const tool of await $.tool.list()) {
      const server = tool.mcp ? /^mcp__(.+?)__/.exec(tool.name)?.[1] : undefined
      if (server !== undefined) seen.add(server)
      if (tool.mcp && server !== undefined && tool.name.endsWith(`__${toolName}`)) {
        return tool.name.slice('mcp__'.length, -`__${toolName}`.length)
      }
    }
  } catch {}
  mcpServersSeen = [...seen]
  return fallback
}

const findClickup = ($: EngineInterface) => findServer($, 'clickup_filter_tasks', CLICKUP)

// Turn a connector failure into one line that says what to do
const explainFailure = (name: string, message: string, server: string, tools: string[]) =>
  /no connected MCP tool/i.test(message)
    ? `${name} is not connected in this session. Connect the ${name} connector, then press r to refresh. MCP servers this session has: ${mcpServersSeen.length > 0 ? mcpServersSeen.join(', ') : 'none'}.`
    : /auto mode classifier/i.test(message)
      ? `Auto mode blocked the ${name} call. Add ${tools.map(tool => `"mcp__${server}__${tool}"`).join(' and ')} to permissions.allow in your settings, then press r.`
      : `${name}: ${message}`

// Your open ClickUp tasks, every page of them
async function loadTasks($: EngineInterface) {
  tasksState = 'loading'
  $.ui.invalidate('ui.render')
  let server = CLICKUP
  try {
    server = await findClickup($)
    let me = await $.store.get('clickupUser')
    if (typeof me !== 'string') {
      const resolved = mcpJson(await $.mcp.call(server, 'clickup_resolve_assignees', { assignees: ['me'] }))
      me = (resolved.userIds as string[] | undefined)?.[0]
      if (typeof me !== 'string') throw new Error('could not find your ClickUp user')
      await $.store.set('clickupUser', me)
    }
    const found: Task[] = []
    for (let page = 0; page < 5; page++) {
      const data = mcpJson(await $.mcp.call(server, 'clickup_filter_tasks', { assignees: [me], order_by: 'updated', page }))
      for (const raw of (data.tasks as Record<string, unknown>[] | undefined) ?? []) {
        found.push({
          id: String(raw.id),
          name: oneLine(String(raw.name ?? '')),
          status: String(raw.status ?? ''),
          url: String(raw.url ?? ''),
          priority: typeof raw.priority === 'string' ? raw.priority : null,
          due: raw.due_date === null || raw.due_date === undefined ? null : Number(raw.due_date),
          list: String((raw.list as { name?: string } | undefined)?.name ?? ''),
        })
      }
      if (data.has_more !== true) break
    }
    tasks = found
    tasksState = 'ready'
  } catch (error) {
    tasksState = 'error'
    const message = error instanceof Error ? error.message : String(error)
    tasksError = explainFailure('ClickUp', message, server, ['clickup_filter_tasks', 'clickup_resolve_assignees'])
  }
  tasksAt = await $.clock.now()
  $.ui.invalidate('ui.render')
}

const PRIORITY_RANK: Record<string, number> = { urgent: 0, high: 1, normal: 2, low: 3 }
const PRIORITY_COLOR: Record<string, string> = { urgent: 'red', high: 'yellow', normal: 'blue', low: 'gray' }

// In progress first, then everything else, needs-clarification and blocked last
const statusRank = (status: string) =>
  /progress|doing|review/i.test(status) ? 0 : /clarif|block|wait|hold/i.test(status) ? 2 : 1

// Open a task in the browser: macOS open, else xdg-open; only ClickUp task links
async function openTask($: EngineInterface, task: Task) {
  if (!/^https:\/\/app\.clickup\.com\//.test(task.url)) throw new Error('not a ClickUp link')
  for (const opener of ['open', 'xdg-open']) {
    try {
      const ran = await $.process.run([opener, task.url], { timeoutMs: 10000 })
      if (ran.exitCode === 0) return
    } catch {}
  }
  throw new Error('no browser opener')
}

let craftTasks: CraftTask[] = []
let craftState: 'never' | 'loading' | 'ready' | 'error' = 'never'
let craftError = ''
let craftAt = 0
let craftServer = CRAFT
// The task whose done button was pressed once and waits for the second press
let craftArmed: { id: string; until: number } | null = null
// The last task marked done, so it can be undone
let craftLastDone: CraftTask | null = null

const CRAFT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const mcpText = (result: { content: { type: string; text?: string }[]; isError: boolean }) => {
  const text = result.content.filter(block => block.type === 'text').map(block => block.text ?? '').join('\n')
  if (result.isError) throw new Error(text || 'the connector returned an error')
  return text
}

// Craft's task list is text: a "[ ] <id> - [ ] text" line, then "(schedule: …, deadline: …)" and "in: …"
const parseCraftTasks = (text: string) => {
  const found: CraftTask[] = []
  let task: CraftTask | null = null
  for (const line of text.split('\n')) {
    const head = /^\[.\] <([0-9a-f-]{36})> - \[.\] (.*)$/i.exec(line)
    if (head !== null) {
      const project = /\s*\[project: ([^\]]+)\]\s*$/.exec(head[2] ?? '')
      task = {
        id: head[1] ?? '',
        text: oneLine((head[2] ?? '').replace(/\s*\[project: [^\]]+\]\s*$/, '')),
        project: project?.[1] ?? '',
        schedule: '',
        deadline: '',
        where: '',
      }
      found.push(task)
      continue
    }
    if (task === null) continue
    const dates = /^\s+\((.*)\)\s*$/.exec(line)
    if (dates !== null) {
      for (const part of (dates[1] ?? '').split(',')) {
        const [key, value] = part.split(':').map(piece => piece.trim())
        if (key === 'schedule') task.schedule = value ?? ''
        if (key === 'deadline') task.deadline = value ?? ''
      }
      continue
    }
    const where = /^\s+in: (.*?)(?: <[0-9a-f-]{36}>)?\s*$/i.exec(line)
    if (where !== null) task.where = where[1] ?? ''
  }
  return found
}

async function loadCraft($: EngineInterface) {
  craftState = 'loading'
  $.ui.invalidate('ui.render')
  try {
    craftServer = await findServer($, 'craft_read', CRAFT)
    craftTasks = parseCraftTasks(mcpText(await $.mcp.call(craftServer, 'craft_read', { command: 'tasks list --scope active' })))
    craftState = 'ready'
  } catch (error) {
    craftState = 'error'
    const message = error instanceof Error ? error.message : String(error)
    craftError = explainFailure('Craft', message, craftServer, ['craft_read', 'craft_write'])
  }
  craftAt = await $.clock.now()
  $.ui.invalidate('ui.render')
}

// Set a task's state in Craft: done moves it to the logbook, todo brings it back
async function setCraftState($: EngineInterface, task: CraftTask, state: 'done' | 'todo') {
  if (!CRAFT_ID.test(task.id)) throw new Error('not a Craft task id')
  mcpText(await $.mcp.call(craftServer, 'craft_write', { command: `tasks update --task ${task.id} --state ${state}` }))
}

// YYYY-MM-DD for a time, in local time
const isoDay = (ms: number) => {
  const day = new Date(ms)
  return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`
}

// Overdue, then today, then later, then no date; by deadline, then schedule within each
const craftGroup = (task: CraftTask, today: string) =>
  task.deadline !== '' && task.deadline < today
    ? 'overdue'
    : task.deadline === today || (task.schedule !== '' && task.schedule <= today)
      ? 'today'
      : task.deadline !== '' || task.schedule !== ''
        ? 'later'
        : 'no date'
const CRAFT_GROUPS = ['overdue', 'today', 'later', 'no date'] as const
const CRAFT_COLOR: Record<string, string> = { overdue: 'red', today: 'green', later: 'cyan', 'no date': 'gray' }

const formatDay = (day: string) =>
  new Date(`${day}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })

const formatDue = (due: number) => new Date(due).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })

// Read each subagent's type, task and status; keep the ones that have left the list
async function refreshAgents($: EngineInterface) {
  try {
    for (const agent of await $.agent.list()) {
      const lane = lanes.get(agent.id)
      lanes.set(agent.id, {
        id: agent.id,
        type: agent.name ?? agent.type,
        description: oneLine(agent.description),
        status: agent.status,
        last: lane?.last ?? ++activity,
      })
    }
  } catch {}
  $.ui.invalidate('ui.render')
}

const formatLeft = (ms: number) =>
  ms >= 2 * MINUTE ? `${Math.floor(ms / MINUTE)}m` : `${Math.max(0, Math.floor(ms / 1000))}s`

const formatTokens = (tokens: number) => (tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : `${tokens}`)

const lastLine = (text: string) => text.trim().split('\n').at(-1)?.replace(/^\W+/, '') ?? ''

// Fetch the marketplace, install the newest version, then reload plugins once the session is idle
async function updatePlugin($: EngineInterface) {
  const manual = 'Run instead: ! claude plugin marketplace update session-hud && claude plugin update session-hud@session-hud'
  try {
    for (const argv of [
      ['claude', 'plugin', 'marketplace', 'update', 'session-hud'],
      ['claude', 'plugin', 'update', 'session-hud@session-hud'],
    ]) {
      const ran = await $.process.run(argv, { timeoutMs: 120000 })
      if (ran.exitCode !== 0) return { text: `Update failed: ${lastLine(ran.stderr || ran.stdout)}. ${manual}` }
      if (argv[2] === 'update' && argv[3] === 'session-hud@session-hud') {
        const result = lastLine(ran.stdout)
        if (/already at the latest/i.test(result)) return { text: `session-hud: ${result}` }
        void $.command.run({ command: 'reload-plugins', args: '' }).catch(() =>
          $.ui.toast('session-hud updated. Run /reload-plugins to load it.'),
        )
        return { text: `${result.replace(/ Restart to apply changes\.?$/, '').replace(/\.+$/, '')}. Reloading plugins…` }
      }
    }
  } catch {
    return { text: `Update could not run claude. ${manual}` }
  }
  return { text: 'Update finished.' }
}

const setCall = ($: EngineInterface, id: string, change: Partial<Call>) => {
  calls = calls.map(call => (call.id === id ? { ...call, ...change } : call))
  $.ui.invalidate('ui.render')
}

// Read the branch and the count of changed files; null outside a repository
async function refreshGit($: EngineInterface) {
  try {
    const head = await $.process.run(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], { timeoutMs: 3000 })
    if (head.exitCode !== 0) {
      git = null
    } else {
      const status = await $.process.run(['git', 'status', '--porcelain'], { timeoutMs: 3000 })
      const dirty = status.stdout.split('\n').filter(line => line.trim() !== '').length
      git = { branch: head.stdout.trim(), dirty }
    }
  } catch {
    git = null
  }
  $.ui.invalidate('ui.render')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'hud',
      description:
        'Show or hide the session HUD band; /hud tools toggles the tool calls pane; /hud tasks your ClickUp tasks; /hud craft your Craft tasks; /hud update installs the latest version',
      argumentHint: '[tools|tasks|craft|update]',
    })
    isHidden = (await $.store.get('isHidden')) === true
    void refreshGit($)
    // Keep the cost and context figures fresh
    $.clock.every(5000, async () => {
      if ([...lanes.values()].some(lane => isActive(lane.status))) void refreshAgents($)
      // Keep the tasks fresh while their pane is open
      if (tasksState !== 'loading' && (await $.clock.now()) - tasksAt > 5 * MINUTE) {
        if ((await $.ui.panes()).some(pane => pane.id === TASKS_PANE)) void loadTasks($)
      }
      if (craftState !== 'loading' && (await $.clock.now()) - craftAt > 5 * MINUTE) {
        if ((await $.ui.panes()).some(pane => pane.id === CRAFT_PANE)) void loadCraft($)
      }
      $.ui.invalidate('ui.render')
    })
    return next(e)
  })

  on('command.run', { command: 'hud' }, async ($, e) => {
    if (e.args.trim() === 'update') return updatePlugin($)
    if (e.args.trim() === 'craft') {
      const panes = await $.ui.panes()
      if (panes.some(pane => pane.id === CRAFT_PANE)) {
        await $.ui.close({ id: CRAFT_PANE })
        return { text: 'Craft pane closed.' }
      }
      void loadCraft($)
      const opened = await $.ui.open({ id: CRAFT_PANE, title: 'Craft' })
      return { text: opened.isPlaced ? 'Craft pane opened.' : 'Craft pane opens once the terminal is wider.' }
    }
    if (e.args.trim() === 'tasks') {
      const panes = await $.ui.panes()
      if (panes.some(pane => pane.id === TASKS_PANE)) {
        await $.ui.close({ id: TASKS_PANE })
        return { text: 'Tasks pane closed.' }
      }
      void loadTasks($)
      const opened = await $.ui.open({ id: TASKS_PANE, title: 'Tasks' })
      return { text: opened.isPlaced ? 'Tasks pane opened.' : 'Tasks pane opens once the terminal is wider.' }
    }
    if (e.args.trim() === 'tools') {
      const panes = await $.ui.panes()
      if (panes.some(pane => pane.id === PANE)) {
        await $.ui.close({ id: PANE })
        return { text: 'Tool calls pane closed.' }
      }
      const opened = await $.ui.open({ id: PANE, title: 'Tool calls' })
      return { text: opened.isPlaced ? 'Tool calls pane opened.' : 'Tool calls pane opens once the terminal is wider.' }
    }
    isHidden = !isHidden
    await $.store.set('isHidden', isHidden)
    $.ui.invalidate('ui.render')
    return { text: isHidden ? 'Session HUD hidden. Run /hud to show it.' : 'Session HUD shown.' }
  })

  on('prompt.submit', async ($, e, next) => {
    turnStartedAt = await $.clock.now()
    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    tools += 1
    byTool.set(e.tool, (byTool.get(e.tool) ?? 0) + 1)
    const id = e.tool_use_id
    if (e.agentId !== undefined) {
      const lane = lanes.get(e.agentId)
      if (lane === undefined) {
        lanes.set(e.agentId, { id: e.agentId, type: 'subagent', description: '', status: 'running', last: ++activity })
        void refreshAgents($)
      } else {
        lanes.set(e.agentId, { ...lane, last: ++activity })
      }
    }
    calls = [...calls, { id, tool: e.tool, target: targetOf(e), why: '', agentId: e.agentId, state: 'running' as const }].slice(-200)
    $.ui.invalidate('ui.render')
    void explain($, id, e.agentId).then(why => why !== '' && setCall($, id, { why }))
    const ran = await next(e)
    setCall($, id, { state: 'deny' in ran || ran.isError === true ? 'error' : 'done' })
    return ran
  }).catch(($, e, next) => next(e))

  // Every skill expansion: /name typed by you, or the Skill tool Claude called
  on('skill.prompt', async ($, e, next) => {
    const name = e.skill.replace(/^\//, '')
    const viaTool = calls.find(
      call => call.tool === 'Skill' && call.state === 'running' && (call.target === name || call.target.endsWith(`:${name}`)),
    )
    if (viaTool !== undefined) {
      setCall($, viaTool.id, { by: 'claude' })
    } else {
      skillSeq += 1
      calls = [...calls, { id: `skill-${skillSeq}`, tool: 'Skill', target: name, why: `you ran /${name}`, state: 'done' as const, by: 'you' as const }].slice(-200)
      $.ui.invalidate('ui.render')
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // Each model request of the main loop resets the prompt cache's clock
  on('turn.step', async function* ($, e, next) {
    const sentAt = await $.clock.now()
    const step = yield* next(e)
    try {
      if (e.agentId === undefined && step.usage !== null) {
        // A cache read after more than five idle minutes means the cache lives an hour
        if (lastRequestAt !== null && sentAt - lastRequestAt > 5 * MINUTE && step.usage.cache_read_input_tokens > 0) {
          learnedTtlMs = HOUR
        }
        lastRequestAt = sentAt
        $.ui.invalidate('ui.render')
      }
    } catch {}
    return step
  })

  on('turn.complete', async ($, e, next) => {
    if ('agentId' in e && typeof e.agentId === 'string') {
      const lane = lanes.get(e.agentId)
      if (lane !== undefined && isActive(lane.status)) lanes.set(e.agentId, { ...lane, status: 'completed' })
      void refreshAgents($)
      return next(e)
    }
    if (turnStartedAt > 0) {
      lastTurnSeconds = Math.round(((await $.clock.now()) - turnStartedAt) / 1000)
    }
    void refreshGit($)
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (isHidden || e.props.hasSurvey) return next(e)
    const { Box, Text } = $.ui.resolve(e)

    const usage = await $.session.usage()
    const percent = usage.context.percent
    const limit = usage.rateLimits.reduce<(typeof usage.rateLimits)[number] | null>(
      (top, one) => (top === null || one.percentUsed > top.percentUsed ? one : top),
      null,
    )

    if (percent !== undefined && percent >= 85 && !hasWarnedContext) {
      hasWarnedContext = true
      $.ui.toast(`Context is ${Math.round(percent)}% full. Consider /compact.`)
    }

    const topTools = [...byTool.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([name, count]) => `${name} ${count}`)
      .join(', ')

    const sep = <Text dimColor> │ </Text>

    // Subscriptions cache prompts for an hour, API keys for five minutes, unless a request showed otherwise
    const ttlMs = learnedTtlMs ?? (usage.rateLimits.length > 0 ? HOUR : 5 * MINUTE)
    const cacheLeft = lastRequestAt !== null ? ttlMs - ((await $.clock.now()) - lastRequestAt) : null
    const cacheColor = cacheLeft === null ? 'green' : cacheLeft < Math.min(2 * MINUTE, ttlMs / 5) ? 'yellow' : 'green'
    const showCache = cacheLeft !== null && !e.props.isWorking

    return (
      <Box flexDirection="row" flexWrap="wrap">
        {git !== null && (
          <Text>
            <Text color="cyan">⎇ {git.branch}</Text>
            {git.dirty > 0 && <Text color="yellow"> ✎{git.dirty}</Text>}
          </Text>
        )}
        {git !== null && sep}
        <Text>
          <Text dimColor>ctx </Text>
          {percent === undefined ? (
            <Text dimColor>–</Text>
          ) : (
            <Text color={levelColor(percent)}>
              {meter(percent)} {Math.round(percent)}%
            </Text>
          )}
        </Text>
        {usage.cost !== undefined && sep}
        {usage.cost !== undefined && <Text color="magenta">${usage.cost.usd.toFixed(2)}</Text>}
        {limit !== null && sep}
        {limit !== null && (
          <Text>
            <Text dimColor>{limit.kind.replace('_', ' ')} </Text>
            <Text color={levelColor(limit.percentUsed)}>{Math.round(limit.percentUsed)}%</Text>
          </Text>
        )}
        {sep}
        <Text>
          <Text dimColor>tools </Text>
          {tools}
          {topTools !== '' && <Text dimColor> ({topTools})</Text>}
        </Text>
        {e.props.isWorking && turnStartedAt > 0 && sep}
        {e.props.isWorking && turnStartedAt > 0 && <Text color="blue">working…</Text>}
        {!e.props.isWorking && lastTurnSeconds !== null && sep}
        {!e.props.isWorking && lastTurnSeconds !== null && (
          <Text dimColor>last turn {formatSeconds(lastTurnSeconds)}</Text>
        )}
        {showCache && sep}
        {showCache && cacheLeft > 0 && (
          <Text>
            <Text dimColor>cache </Text>
            <Text color={cacheColor}>warm {formatLeft(cacheLeft)}</Text>
          </Text>
        )}
        {showCache && cacheLeft <= 0 && (
          <Text>
            <Text dimColor>cache </Text>
            <Text color="red">cold</Text>
            {(usage.context.tokens ?? 0) > 0 && <Text dimColor> · next send rewrites {formatTokens(usage.context.tokens ?? 0)} tokens</Text>}
          </Text>
        )}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const glyph = { running: '●', done: '✓', error: '✗' } as const
    const color = { running: 'yellow', done: 'green', error: 'red' } as const
    const laneState = (status: AgentStatus) =>
      isActive(status) ? 'running' : status === 'failed' || status === 'killed' ? 'error' : 'done'

    // Running subagents first, then the main session's tools, then finished subagents
    const main = calls.filter(call => call.agentId === undefined)
    const byLane = new Map<string, Call[]>()
    for (const call of calls) {
      if (call.agentId !== undefined) byLane.set(call.agentId, [...(byLane.get(call.agentId) ?? []), call])
    }
    const all = [...lanes.values()].filter(lane => byLane.has(lane.id)).sort((a, b) => b.last - a.last)
    const candidates: Section[] = [
      ...all.filter(lane => isActive(lane.status)).map(lane => ({ kind: 'lane' as const, lane, count: 0, recent: byLane.get(lane.id) ?? [] })),
      ...(all.length > 0 && main.length > 0 ? [{ kind: 'heading' as const, text: 'Main session' }] : []),
      ...groupCalls(main).map(group => ({ kind: 'group' as const, group, recent: group.calls })),
      ...all.filter(lane => !isActive(lane.status)).map(lane => ({ kind: 'lane' as const, lane, count: 0, recent: byLane.get(lane.id) ?? [] })),
    ]

    // Every section keeps its heading row; the rows left go to calls, two rows each, in order
    let rows = Math.max(3, (e.viewport?.rows ?? 24) - 1)
    const fitting = candidates.slice(0, Math.max(1, rows - (candidates.length > rows ? 1 : 0)))
    rows -= fitting.length
    const shown: Section[] = fitting.map(section => {
      if (section.kind === 'heading') return section
      const total = section.recent.length
      const room = Math.min(3, total, Math.max(0, Math.floor(rows / 2)))
      rows -= room * 2
      const recent = room === 0 ? [] : section.recent.slice(-room)
      return section.kind === 'lane' ? { ...section, count: total, recent } : { ...section, recent }
    })
    const hidden = candidates.filter(section => section.kind !== 'heading').length -
      shown.filter(section => section.kind !== 'heading').length

    const callRows = (call: Call, withTool: boolean) => (
      <Box flexDirection="column">
        <Text wrap="truncate-end">
          {'  '}
          <Text color={color[call.state]}>{glyph[call.state]} </Text>
          {withTool && <Text bold>{groupOf(call.tool)} </Text>}
          {call.target === '' ? <Text dimColor>(no arguments)</Text> : <Text>{call.target}</Text>}
          {call.by === 'you' && <Text dimColor> · by you</Text>}
          {call.by === 'claude' && <Text dimColor> · by Claude</Text>}
        </Text>
        <Text dimColor wrap="truncate-end">
          {'    '}
          {call.why === '' ? '–' : call.why}
        </Text>
      </Box>
    )

    return (
      <Box flexDirection="column">
        {calls.length === 0 && <Text dimColor>No tool calls yet.</Text>}
        {shown.map(section => {
          if (section.kind === 'heading') {
            return (
              <Text bold dimColor>
                {section.text}
              </Text>
            )
          }
          if (section.kind === 'lane') {
            const state = laneState(section.lane.status)
            return (
              <Box flexDirection="column">
                <Text wrap="truncate-end">
                  <Text color={color[state]}>{glyph[state]} </Text>
                  <Text bold color="magenta">{section.lane.type}</Text>
                  {section.lane.description !== '' && <Text> {section.lane.description}</Text>}
                  <Text dimColor> · {section.count} calls{state === 'running' ? ', running' : ''}</Text>
                </Text>
                {section.recent.map(call => callRows(call, true))}
              </Box>
            )
          }
          return (
            <Box flexDirection="column">
              <Text wrap="truncate-end">
                <Text bold color="cyan">{section.group.name}</Text>
                <Text dimColor> ×{section.group.calls.length}</Text>
                {section.group.calls.length > section.recent.length && section.recent.length > 0 && <Text dimColor>, latest {section.recent.length}</Text>}
              </Text>
              {section.recent.map(call => callRows(call, false))}
            </Box>
          )
        })}
        {hidden > 0 && <Text dimColor>+{hidden} more sections not shown (pane too short)</Text>}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: TASKS_PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const columns = e.viewport?.columns ?? 60
    const now = await $.clock.now()

    // Put the task in the prompt box, after anything already typed
    const pick = async (task: Task) => {
      const line = `Work on ClickUp task "${task.name}" (${task.url}).`
      const box = await $.prompt.read()
      await $.prompt.fill(box.text.trim() === '' ? { text: line } : { text: ` ${line}`, mode: 'append' })
    }

    const header = (
      <Box flexDirection="row" columnGap={2}>
        <Text dimColor wrap="truncate-end">
          {tasksState === 'loading'
            ? 'Loading your ClickUp tasks…'
            : tasksState === 'error'
              ? 'Could not load your tasks'
              : `${tasks.length} open · updated ${formatLeft(now - tasksAt)} ago`}
        </Text>
        <Button key="refresh" label="refresh" hotkey="r" plain onPress={() => void loadTasks($)} />
      </Box>
    )
    const problem = tasksState === 'error' ? <Text color="yellow" wrap="wrap">{tasksError}</Text> : null

    const sorted = [...tasks].sort(
      (a, b) =>
        statusRank(a.status) - statusRank(b.status) ||
        a.status.localeCompare(b.status) ||
        (PRIORITY_RANK[a.priority ?? ''] ?? 4) - (PRIORITY_RANK[b.priority ?? ''] ?? 4),
    )

    // A status heading, then two rows per task, as many as the pane holds
    let rows = Math.max(3, (e.viewport?.rows ?? 24) - 2)
    const shown: ({ kind: 'status'; status: string } | { kind: 'task'; task: Task; index: number })[] = []
    let last = ''
    sorted.forEach((task, index) => {
      const cost = (task.status !== last ? 1 : 0) + 2
      if (rows < cost) return
      if (task.status !== last) shown.push({ kind: 'status', status: task.status })
      shown.push({ kind: 'task', task, index })
      last = task.status
      rows -= cost
    })
    const hidden = sorted.length - shown.filter(item => item.kind === 'task').length

    return (
      <Box flexDirection="column">
        {header}
        {problem}
        {tasksState === 'ready' && tasks.length === 0 && <Text dimColor>No open tasks assigned to you.</Text>}
        {shown.map(item => {
          if (item.kind === 'status') {
            return (
              <Text bold color={statusRank(item.status) === 0 ? 'green' : statusRank(item.status) === 2 ? 'yellow' : 'cyan'}>
                {item.status}
              </Text>
            )
          }
          const { task, index } = item
          const isOverdue = task.due !== null && task.due < now
          const room = columns - 14
          const label = task.name.length > room ? `${task.name.slice(0, room - 1)}…` : task.name
          return (
            <Box flexDirection="column">
              <Box flexDirection="row" columnGap={2}>
                <Button
                  key={`task-${task.id}`}
                  label={label}
                  plain
                  {...(index < 9 ? { hotkey: String(index + 1) } : {})}
                  onPress={() => void pick(task).catch(() => $.ui.toast('Could not put the task in the prompt.'))}
                />
                <Button
                  key={`open-${task.id}`}
                  label="↗ open"
                  plain
                  dimColor
                  onPress={() => void openTask($, task).catch(() => $.ui.toast(`Could not open ${task.url}`))}
                />
              </Box>
              <Text wrap="truncate-end">
                {'   '}
                <Text dimColor>{task.list}</Text>
                {task.priority !== null && <Text color={PRIORITY_COLOR[task.priority] ?? 'gray'}> · {task.priority}</Text>}
                {task.due !== null && <Text color={isOverdue ? 'red' : undefined} dimColor={!isOverdue}> · due {formatDue(task.due)}</Text>}
              </Text>
            </Box>
          )
        })}
        {hidden > 0 && <Text dimColor>+{hidden} more tasks not shown (pane too short)</Text>}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: CRAFT_PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const columns = e.viewport?.columns ?? 60
    const now = await $.clock.now()
    const today = isoDay(now)
    const redraw = () => $.ui.invalidate('ui.render')

    // First press arms the button for five seconds, the second marks the task done
    const done = async (task: CraftTask) => {
      if (craftArmed?.id !== task.id || craftArmed.until < (await $.clock.now())) {
        craftArmed = { id: task.id, until: (await $.clock.now()) + 5000 }
        redraw()
        return
      }
      craftArmed = null
      await setCraftState($, task, 'done')
      craftTasks = craftTasks.filter(one => one.id !== task.id)
      craftLastDone = task
      $.ui.toast(`Done: ${task.text.slice(0, 60)}`)
      redraw()
    }

    const undo = async () => {
      const task = craftLastDone
      if (task === null) return
      await setCraftState($, task, 'todo')
      craftLastDone = null
      craftTasks = [task, ...craftTasks]
      $.ui.toast(`Back to do: ${task.text.slice(0, 60)}`)
      redraw()
    }

    const pick = async (task: CraftTask) => {
      const line = `Help me with my Craft task: "${task.text}"`
      const box = await $.prompt.read()
      await $.prompt.fill(box.text.trim() === '' ? { text: line } : { text: ` ${line}`, mode: 'append' })
    }

    const header = (
      <Box flexDirection="row" columnGap={2}>
        <Text dimColor wrap="truncate-end">
          {craftState === 'loading'
            ? 'Loading your Craft tasks…'
            : craftState === 'error'
              ? 'Could not load your tasks'
              : `${craftTasks.length} active · updated ${formatLeft(now - craftAt)} ago`}
        </Text>
        <Button key="craft-refresh" label="refresh" hotkey="r" plain onPress={() => void loadCraft($)} />
        {craftLastDone !== null && (
          <Button
            key="craft-undo"
            label="undo"
            hotkey="u"
            plain
            onPress={() => void undo().catch(() => $.ui.toast('Could not undo in Craft.'))}
          />
        )}
      </Box>
    )

    // A group heading, then two rows per task, as many as the pane holds
    const ordered = CRAFT_GROUPS.flatMap(group =>
      craftTasks
        .filter(task => craftGroup(task, today) === group)
        .sort((a, b) => (a.deadline || '9999').localeCompare(b.deadline || '9999') || (a.schedule || '9999').localeCompare(b.schedule || '9999'))
        .map(task => ({ group, task })),
    )
    let rows = Math.max(3, (e.viewport?.rows ?? 24) - 2)
    const shown: ({ kind: 'group'; group: string; count: number } | { kind: 'task'; task: CraftTask; index: number })[] = []
    let last = ''
    ordered.forEach(({ group, task }, index) => {
      const cost = (group !== last ? 1 : 0) + 2
      if (rows < cost) return
      if (group !== last) shown.push({ kind: 'group', group, count: ordered.filter(one => one.group === group).length })
      shown.push({ kind: 'task', task, index })
      last = group
      rows -= cost
    })
    const hidden = ordered.length - shown.filter(item => item.kind === 'task').length

    return (
      <Box flexDirection="column">
        {header}
        {craftState === 'error' && <Text color="yellow" wrap="wrap">{craftError}</Text>}
        {craftState === 'ready' && craftTasks.length === 0 && <Text dimColor>No active tasks. Nice.</Text>}
        {shown.map(item => {
          if (item.kind === 'group') {
            return (
              <Text bold color={CRAFT_COLOR[item.group] ?? 'cyan'}>
                {item.group} <Text dimColor>{item.count}</Text>
              </Text>
            )
          }
          const { task, index } = item
          const isArmed = craftArmed?.id === task.id && craftArmed.until >= now
          const room = columns - (isArmed ? 22 : 16)
          const label = task.text.length > room ? `${task.text.slice(0, room - 1)}…` : task.text
          const isLate = task.deadline !== '' && task.deadline < today
          return (
            <Box flexDirection="column">
              <Box flexDirection="row" columnGap={2}>
                <Button
                  key={`craft-${task.id}`}
                  label={label}
                  plain
                  {...(index < 9 ? { hotkey: String(index + 1) } : {})}
                  onPress={() => void pick(task).catch(() => $.ui.toast('Could not put the task in the prompt.'))}
                />
                <Button
                  key={`craft-done-${task.id}`}
                  label={isArmed ? '✓ press again' : '✓ done'}
                  plain
                  dimColor={!isArmed}
                  onPress={() => void done(task).catch(() => $.ui.toast('Could not mark the task done in Craft.'))}
                />
              </Box>
              <Text wrap="truncate-end">
                {'   '}
                {task.deadline !== '' && <Text color={isLate ? 'red' : undefined} dimColor={!isLate}>due {formatDay(task.deadline)}</Text>}
                {task.deadline !== '' && task.schedule !== '' && <Text dimColor> · </Text>}
                {task.schedule !== '' && <Text dimColor>planned {formatDay(task.schedule)}</Text>}
                {(task.deadline !== '' || task.schedule !== '') && <Text dimColor> · </Text>}
                <Text dimColor>{task.project !== '' ? task.project : task.where}</Text>
              </Text>
            </Box>
          )
        })}
        {hidden > 0 && <Text dimColor>+{hidden} more tasks not shown (pane too short)</Text>}
      </Box>
    )
  })
}
