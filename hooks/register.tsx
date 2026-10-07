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
const KPI_PANE = 'hud-kpi'
const NEXT_PANE = 'hud-next'
const GIT_PANE = 'hud-git'
const WRAP_PANE = 'hud-wrap'
const HELP_PANE = 'hud-help'

// One repository you worked in this week, and what is left in it
type Repo = {
  top: string
  name: string
  branch: string
  changed: number
  unpushed: number
  commitsToday: string[]
  prs: { number: number; title: string; url: string }[]
}
// A focus block or the break after it, shared by every session through the store
type Focus = { mode: 'focus' | 'break'; until: number; minutes: number }
type Wrap = { day: string; done: string[]; open: string[]; tomorrow: string[] }

// A next prompt worth sending, suggested from your recent sessions
type Suggestion = { project: string; cwd: string; prompt: string; why: string }
// What one recent session was about, read from its transcript's tail
type Digest = { project: string; cwd: string; branch: string; title: string; at: number; prompts: string[]; reply: string }

// One session's record for one day; the pane adds up every session's
type DayRecord = { prompts: number; hours: number[]; tasksDone: number; focus: number }
type Kpis = {
  today: DayRecord
  week: { day: string; prompts: number; usage: number | null }[]
  weeks: number[]
  streak: number
}
type Settings = { goal: number; idleMinutes: number; startHour: number; endHour: number; sound: boolean; focusMinutes: number; breakMinutes: number }
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

// Open a link with the system's handler: macOS open, else xdg-open
async function openLink($: EngineInterface, url: string) {
  for (const opener of ['open', 'xdg-open']) {
    try {
      const ran = await $.process.run([opener, url], { timeoutMs: 10000 })
      if (ran.exitCode === 0) return
    } catch {}
  }
  throw new Error('no opener')
}

// Only ClickUp task links are opened
async function openTask($: EngineInterface, task: Task) {
  if (!/^https:\/\/app\.clickup\.com\//.test(task.url)) throw new Error('not a ClickUp link')
  await openLink($, task.url)
}

const DEFAULT_SETTINGS: Settings = { goal: 30, idleMinutes: 30, startHour: 9, endHour: 19, sound: true, focusMinutes: 25, breakMinutes: 5 }

const chime = ($: EngineInterface) => $.audio.play({ asset: 'sounds/chime.wav' }, { gain: 0.8 })
let settings: Settings = DEFAULT_SETTINGS
let sessionId = 'session'
let kpis: Kpis | null = null
let isTurnRunning = false
let lastPromptAt = 0

const emptyDay = (): DayRecord => ({ prompts: 0, hours: Array.from({ length: 24 }, () => 0), tasksDone: 0, focus: 0 })
const dayKey = (day: string) => `kpi:${day}:${sessionId}`

// The days of the week holding a time, Monday first
const weekDays = (ms: number) => {
  const day = new Date(ms)
  const monday = new Date(day.getFullYear(), day.getMonth(), day.getDate() - ((day.getDay() + 6) % 7), 12)
  return Array.from({ length: 7 }, (_, i) => isoDay(monday.getTime() + i * 24 * HOUR))
}

// Add to this session's record for today
async function bumpToday($: EngineInterface, change: (record: DayRecord) => void) {
  const now = await $.clock.now()
  const key = dayKey(isoDay(now))
  const saved = await $.store.get(key)
  const record = saved !== null && typeof saved === 'object' ? { ...emptyDay(), ...(saved as Partial<DayRecord>) } : emptyDay()
  change(record)
  await $.store.set(key, record)
}

// Keep the highest seven-day reading per day and per window, for the history
async function recordUsage($: EngineInterface) {
  try {
    const usage = await $.session.usage()
    const week = usage.rateLimits.find(limit => limit.kind === 'seven_day')
    if (week === undefined) return
    const today = isoDay(await $.clock.now())
    const day = await $.store.get(`usage:${today}`)
    if (typeof day !== 'number' || week.percentUsed > day) await $.store.set(`usage:${today}`, week.percentUsed)
    if (week.resetsAt !== undefined) {
      const key = `week:${week.resetsAt.slice(0, 10)}`
      const best = await $.store.get(key)
      if (typeof best !== 'number' || week.percentUsed > best) await $.store.set(key, week.percentUsed)
    }
  } catch {}
}

// Add up every session's records: today, this week by day, past weeks and the goal streak
async function loadKpis($: EngineInterface) {
  const now = await $.clock.now()
  const today = isoDay(now)
  const days = weekDays(now)
  const byDay = new Map<string, DayRecord>()
  const keys = await $.store.keys()
  for (const key of keys) {
    const match = /^kpi:(\d{4}-\d{2}-\d{2}):/.exec(key)
    if (match?.[1] === undefined) continue
    const saved = (await $.store.get(key)) as Partial<DayRecord> | null
    if (saved === null || typeof saved !== 'object') continue
    const total = byDay.get(match[1]) ?? emptyDay()
    total.prompts += saved.prompts ?? 0
    total.tasksDone += saved.tasksDone ?? 0
    total.focus += saved.focus ?? 0
    saved.hours?.forEach((count, hour) => (total.hours[hour] = (total.hours[hour] ?? 0) + count))
    byDay.set(match[1], total)
  }
  // Usage per day: the rise of the seven-day reading since the day before
  const week = await Promise.all(
    days.map(async (day, i) => {
      const reading = await $.store.get(`usage:${day}`)
      const before = i === 0 ? await $.store.get(`usage:${isoDay(new Date(`${day}T12:00:00`).getTime() - 24 * HOUR)}`) : await $.store.get(`usage:${days[i - 1]}`)
      const usage = typeof reading === 'number' ? Math.max(0, reading - (typeof before === 'number' && before <= reading ? before : 0)) : null
      return { day, prompts: byDay.get(day)?.prompts ?? 0, usage: day > today ? null : usage }
    }),
  )
  const weeks: number[] = []
  for (const key of keys.filter(key => key.startsWith('week:')).sort().slice(-5, -1)) {
    const value = await $.store.get(key)
    if (typeof value === 'number') weeks.push(value)
  }
  // Days in a row that met the goal, ending today or yesterday
  let streak = 0
  for (let i = 0; i < 60; i++) {
    const day = isoDay(now - i * 24 * HOUR)
    const prompts = byDay.get(day)?.prompts ?? 0
    if (prompts >= settings.goal) streak += 1
    else if (i > 0) break
  }
  kpis = { today: byDay.get(today) ?? emptyDay(), week, weeks, streak }
  $.ui.invalidate('ui.render')
}

// Forget records older than five weeks
async function pruneKpis($: EngineInterface) {
  const oldest = isoDay((await $.clock.now()) - 35 * 24 * HOUR)
  for (const key of await $.store.keys()) {
    const day = /^(?:kpi|usage):(\d{4}-\d{2}-\d{2})/.exec(key)?.[1]
    if (day !== undefined && day < oldest) await $.store.delete(key)
  }
}

const isWorkTime = (ms: number) => {
  const day = new Date(ms)
  const hour = day.getHours()
  return day.getDay() >= 1 && day.getDay() <= 5 && hour >= settings.startHour && hour < settings.endHour
}

// Nudge when nobody prompted in any session for a while during work hours; one session nudges
async function checkIdle($: EngineInterface) {
  if (settings.idleMinutes <= 0 || isTurnRunning || focus !== null) return
  const now = await $.clock.now()
  if (!isWorkTime(now)) return
  const shared = await $.store.get('lastPrompt')
  const last = Math.max(lastPromptAt, typeof shared === 'number' ? shared : 0)
  const idleMs = settings.idleMinutes * MINUTE
  const startOfWork = new Date(now).setHours(settings.startHour, 0, 0, 0)
  if (now - Math.max(last, startOfWork) < idleMs) return
  const nudged = await $.store.get('idleNudgeAt')
  if (typeof nudged === 'number' && now - nudged < idleMs) return
  await $.store.set('idleNudgeAt', now)
  const idleFor = last > startOfWork ? `No prompt for ${formatLeft(now - last)}` : 'No prompt yet today'
  const usage = await $.session.usage().catch(() => null)
  const week = usage?.rateLimits.find(limit => limit.kind === 'seven_day')
  const pace = week === undefined ? '' : ` · week ${Math.round(week.percentUsed)}% used`
  const idea = suggestions[0]
  const next = craftTasks.find(task => craftGroup(task, isoDay(now)) !== 'later' && craftGroup(task, isoDay(now)) !== 'no date')
  const hint = idea !== undefined ? `${idea.project}: ${idea.prompt}` : next !== undefined ? next.text : ''
  $.ui.toast(`${idleFor}${pace}.${hint !== '' ? ` Next: ${hint.slice(0, 70)}` : ''}`)
  if (settings.sound) void chime($).catch(() => {})
  const text = idea !== undefined ? idea.prompt : next !== undefined ? `Help me with my Craft task: "${next.text}"` : ''
  if (text !== '') void $.prompt.suggest({ text }).catch(() => {})
}

// Where a limit ends up by its reset at the current rate
const pace = (percentUsed: number, resetsAt: string | undefined, windowMs: number, now: number) => {
  if (resetsAt === undefined) return null
  const left = Math.max(0, new Date(resetsAt).getTime() - now)
  const elapsed = Math.min(1, Math.max(0.01, 1 - left / windowMs))
  return { elapsed: elapsed * 100, projected: Math.min(999, percentUsed / elapsed), left }
}

const formatSpan = (ms: number) => {
  const hours = Math.floor(ms / HOUR)
  return hours >= 24 ? `${Math.floor(hours / 24)}d ${hours % 24}h` : hours > 0 ? `${hours}h ${Math.floor((ms % HOUR) / MINUTE)}m` : `${Math.floor(ms / MINUTE)}m`
}

const SPARK = '▁▂▃▄▅▆▇█'
const spark = (values: number[]) => {
  const top = Math.max(1, ...values)
  return values.map(value => (value === 0 ? '·' : SPARK[Math.min(7, Math.floor((value / top) * 7.999))])).join('')
}

let suggestions: Suggestion[] = []
let suggestState: 'never' | 'loading' | 'ready' | 'error' = 'never'
let suggestError = ''
let suggestAt = 0

// A user message's own words, or '' for tool results, reminders and command wrappers
const promptText = (content: unknown) => {
  const text =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content.map(block => (block?.type === 'text' && typeof block.text === 'string' ? block.text : '')).join('\n')
        : ''
  const clean = text.trim()
  return clean === '' || clean.startsWith('<') ? '' : oneLine(clean)
}

// The tail of one transcript, digested: your last prompts and the last reply
async function digestSession($: EngineInterface, path: string, at: number): Promise<Digest | null> {
  const tail = await $.process.run(['tail', '-c', '600000', path], { timeoutMs: 10000 })
  if (tail.exitCode !== 0) return null
  const digest: Digest = { project: '', cwd: '', branch: '', title: '', at, prompts: [], reply: '' }
  for (const line of tail.stdout.split('\n').slice(1)) {
    let entry: Record<string, unknown>
    try {
      entry = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    if (typeof entry.cwd === 'string') digest.cwd = entry.cwd
    if (typeof entry.gitBranch === 'string') digest.branch = entry.gitBranch
    if (entry.type === 'custom-title' && typeof entry.customTitle === 'string') digest.title = entry.customTitle
    if (entry.isSidechain === true) continue
    const message = entry.message as { content?: unknown } | undefined
    // Only what you wrote: skill text, command wrappers and agents' messages carry no human origin
    if (entry.type === 'user' && (entry.origin as { kind?: string } | undefined)?.kind === 'human') {
      const text = promptText(message?.content)
      if (text !== '') digest.prompts.push(text.slice(0, 300))
    }
    if (entry.type === 'assistant' && Array.isArray(message?.content)) {
      const text = message.content
        .map(block => (block?.type === 'text' && typeof block.text === 'string' ? block.text : ''))
        .join(' ')
        .trim()
      if (text !== '') digest.reply = oneLine(text).slice(0, 700)
    }
  }
  digest.prompts = digest.prompts.slice(-4)
  digest.project = digest.cwd.split('/').filter(part => part !== '').at(-1) ?? ''
  return digest.prompts.length > 0 ? digest : null
}

// Your ten most recently active sessions, newest first
async function recentSessions($: EngineInterface) {
  const home = await $.env.get('HOME')
  if (home === undefined) throw new Error('no home folder')
  const root = `${home}/.claude/projects`
  const files: { path: string; at: number }[] = []
  for (const folder of await $.fs.list(root)) {
    if (folder.kind !== 'dir') continue
    for (const file of await $.fs.list(`${root}/${folder.name}`).catch(() => [])) {
      if (file.kind === 'file' && file.name.endsWith('.jsonl')) files.push({ path: `${root}/${folder.name}/${file.name}`, at: file.mtimeMs })
    }
  }
  files.sort((a, b) => b.at - a.at)
  const digests: Digest[] = []
  for (const file of files.slice(0, 25)) {
    const digest = await digestSession($, file.path, file.at).catch(() => null)
    if (digest !== null) digests.push(digest)
    if (digests.length === 10) break
  }
  return digests
}

const SUGGEST_SYSTEM = `You help a developer keep momentum across their Claude Code sessions. You get digests of their most recent sessions: the project, branch, their last prompts and Claude's last reply. Suggest the 3 to 5 most valuable next prompts they could send now. Prefer finishing what is half done, following up on what Claude proposed or asked, and verifying what was just built. Each prompt must be concrete, written in the user's own voice and language, and ready to send as is. Answer with only a JSON array of objects with keys "project" (the project folder name), "prompt", and "why" (under 12 words).`

async function loadSuggestions($: EngineInterface) {
  suggestState = 'loading'
  $.ui.invalidate('ui.render')
  try {
    const digests = await recentSessions($)
    if (digests.length === 0) throw new Error('no recent sessions with prompts found')
    const now = await $.clock.now()
    const prompt = digests
      .map(
        (digest, i) =>
          `## Session ${i + 1}: ${digest.project}${digest.branch !== '' ? ` (${digest.branch})` : ''}${digest.title !== '' ? ` — ${digest.title}` : ''}, active ${formatSpan(now - digest.at)} ago\n` +
          `Last prompts:\n${digest.prompts.map(text => `- ${text}`).join('\n')}\n` +
          `Claude's last reply: ${digest.reply || '(none)'}`,
      )
      .join('\n\n')
    const result = await $.model.complete({ model: 'sonnet', system: SUGGEST_SYSTEM, prompt, maxTokens: 1500 })
    if (!result.isAnswered) throw new Error(`the model gave no answer (${result.reason})`)
    const json = result.text.slice(result.text.indexOf('['), result.text.lastIndexOf(']') + 1)
    const parsed = JSON.parse(json) as Partial<Suggestion>[]
    const cwdOf = new Map(digests.map(digest => [digest.project, digest.cwd]))
    suggestions = parsed
      .filter(one => typeof one.prompt === 'string' && one.prompt.trim() !== '')
      .slice(0, 5)
      .map(one => ({
        project: String(one.project ?? ''),
        cwd: cwdOf.get(String(one.project ?? '')) ?? '',
        prompt: oneLine(String(one.prompt)),
        why: oneLine(String(one.why ?? '')),
      }))
    suggestState = 'ready'
    suggestAt = now
    await $.store.set('suggestions', { at: now, list: suggestions })
  } catch (error) {
    suggestState = 'error'
    suggestError = error instanceof Error ? error.message : String(error)
  }
  $.ui.invalidate('ui.render')
}

const formatClock = (ms: number) => new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
const formatCountdown = (ms: number) => {
  const seconds = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

// ----- Git: the repositories you worked in this week

let repos: Repo[] = []
let reposState: 'never' | 'loading' | 'ready' | 'error' = 'never'
let reposError = ''
let reposAt = 0

// The folders your sessions worked in since a time, read from each transcript's tail
async function recentFolders($: EngineInterface, since: number) {
  const home = await $.env.get('HOME')
  if (home === undefined) return []
  const root = `${home}/.claude/projects`
  const folders = new Set<string>()
  for (const folder of await $.fs.list(root).catch(() => [])) {
    if (folder.kind !== 'dir') continue
    for (const file of await $.fs.list(`${root}/${folder.name}`).catch(() => [])) {
      if (file.kind !== 'file' || !file.name.endsWith('.jsonl') || file.mtimeMs < since) continue
      const tail = await $.process.run(['tail', '-c', '20000', `${root}/${folder.name}/${file.name}`], { timeoutMs: 5000 }).catch(() => null)
      const cwd = [...(tail?.stdout ?? '').matchAll(/"cwd":"((?:[^"\\]|\\.)+)"/g)].at(-1)?.[1]
      if (cwd !== undefined) folders.add(cwd)
    }
  }
  return [...folders]
}

const runGit = async ($: EngineInterface, top: string, args: string[]) => {
  const ran = await $.process.run(['git', '-C', top, ...args], { timeoutMs: 8000 })
  return ran.exitCode === 0 ? ran.stdout.trim() : null
}

async function readRepo($: EngineInterface, top: string, midnight: number): Promise<Repo> {
  const [branch, status, unpushed, email] = await Promise.all([
    runGit($, top, ['rev-parse', '--abbrev-ref', 'HEAD']),
    runGit($, top, ['status', '--porcelain']),
    runGit($, top, ['rev-list', '--count', 'HEAD', '--not', '--remotes']),
    runGit($, top, ['config', 'user.email']),
  ])
  const log =
    email === null || email === ''
      ? null
      : await runGit($, top, ['log', `--since=${new Date(midnight).toISOString()}`, `--author=${email}`, '--format=%s'])
  let prs: Repo['prs'] = []
  try {
    const ran = await $.process.run(['gh', 'pr', 'list', '--author', '@me', '--state', 'open', '--json', 'number,title,url', '--limit', '5'], {
      cwd: top,
      timeoutMs: 15000,
    })
    if (ran.exitCode === 0) prs = JSON.parse(ran.stdout) as Repo['prs']
  } catch {}
  return {
    top,
    name: top.split('/').filter(part => part !== '').at(-1) ?? top,
    branch: branch ?? '?',
    changed: (status ?? '').split('\n').filter(line => line.trim() !== '').length,
    unpushed: Number(unpushed ?? 0) || 0,
    commitsToday: (log ?? '').split('\n').filter(line => line.trim() !== ''),
    prs,
  }
}

// Every repository your sessions touched in the last 7 days, the ones with work left first
async function loadRepos($: EngineInterface) {
  reposState = 'loading'
  $.ui.invalidate('ui.render')
  try {
    const now = await $.clock.now()
    const tops = new Set<string>()
    for (const folder of await recentFolders($, now - 7 * 24 * HOUR)) {
      const top = await runGit($, folder, ['rev-parse', '--show-toplevel']).catch(() => null)
      if (top !== null && top !== '') tops.add(top)
      if (tops.size >= 15) break
    }
    const midnight = new Date(now).setHours(0, 0, 0, 0)
    repos = (await Promise.all([...tops].map(top => readRepo($, top, midnight).catch(() => null))))
      .filter((repo): repo is Repo => repo !== null)
      .sort((a, b) => b.changed + b.unpushed * 2 + b.prs.length * 3 - (a.changed + a.unpushed * 2 + a.prs.length * 3))
    reposState = 'ready'
    reposAt = now
  } catch (error) {
    reposState = 'error'
    reposError = error instanceof Error ? error.message : String(error)
  }
  $.ui.invalidate('ui.render')
}

// ----- Focus timer

let focus: Focus | null = null

async function readFocus($: EngineInterface) {
  const saved = (await $.store.get('focus')) as Focus | null
  focus = saved !== null && typeof saved === 'object' && typeof saved.until === 'number' ? saved : null
}

async function startFocus($: EngineInterface, minutes: number) {
  const now = await $.clock.now()
  focus = { mode: 'focus', until: now + minutes * MINUTE, minutes }
  await $.store.set('focus', focus)
  $.ui.invalidate('ui.render')
}

async function stopFocus($: EngineInterface) {
  focus = null
  await $.store.delete('focus')
  $.ui.invalidate('ui.render')
}

// When a block or a break runs out: one session chimes, counts the block and starts the break
async function checkFocus($: EngineInterface) {
  await readFocus($)
  if (focus === null) return
  const now = await $.clock.now()
  if (now < focus.until) return
  const ended = await $.store.get('focusEndedAt')
  if (ended === focus.until) return
  await $.store.set('focusEndedAt', focus.until)
  if (settings.sound) void chime($).catch(() => {})
  if (focus.mode === 'focus') {
    const minutes = focus.minutes
    void bumpToday($, record => (record.focus += 1)).then(() => loadKpis($)).catch(() => {})
    focus = { mode: 'break', until: now + settings.breakMinutes * MINUTE, minutes }
    await $.store.set('focus', focus)
    $.ui.toast(`Focus block done (${minutes}m). Break until ${formatClock(focus.until)}.`)
  } else {
    await stopFocus($)
    const idea = suggestions[0]
    $.ui.toast(`Break's over.${idea !== undefined ? ` Next: ${idea.project}: ${idea.prompt.slice(0, 60)}` : ' /hud focus for another block.'}`)
    if (idea !== undefined) void $.prompt.suggest({ text: idea.prompt }).catch(() => {})
  }
  $.ui.invalidate('ui.render')
}

// ----- End-of-day wrap

let wrap: Wrap | null = null
let wrapState: 'never' | 'loading' | 'ready' | 'error' = 'never'
let wrapError = ''
let wrapSaved = ''

const WRAP_SYSTEM = `You write a developer's end-of-day note from what happened in their Claude Code sessions today. Be concrete and short: name projects, features and PRs. Answer with only a JSON object with three arrays of short strings: "done" (what got finished or shipped, at most 6), "open" (what is half done or waiting, at most 5), "tomorrow" (the first 3 concrete next steps, most important first, each a ready-to-send prompt in the user's own voice).`

async function loadWrap($: EngineInterface) {
  wrapState = 'loading'
  wrapSaved = ''
  $.ui.invalidate('ui.render')
  try {
    const now = await $.clock.now()
    const midnight = new Date(now).setHours(0, 0, 0, 0)
    await loadKpis($)
    await loadRepos($)
    const sessions = (await recentSessions($)).filter(digest => digest.at >= midnight)
    const commits = repos.flatMap(repo => repo.commitsToday.map(subject => `${repo.name}: ${subject}`))
    const left = repos
      .filter(repo => repo.changed > 0 || repo.unpushed > 0 || repo.prs.length > 0)
      .map(repo => `${repo.name} (${repo.branch}): ${repo.changed} changed files, ${repo.unpushed} unpushed commits${repo.prs.length > 0 ? `, open PRs ${repo.prs.map(pr => `#${pr.number} ${pr.title}`).join('; ')}` : ''}`)
    const prompt = [
      `Today: ${kpis?.today.prompts ?? 0} prompts, ${kpis?.today.focus ?? 0} focus blocks, ${kpis?.today.tasksDone ?? 0} Craft tasks done.`,
      `## Commits today\n${commits.length > 0 ? commits.map(line => `- ${line}`).join('\n') : '(none)'}`,
      `## Work left in repositories\n${left.length > 0 ? left.map(line => `- ${line}`).join('\n') : '(none)'}`,
      `## Sessions today\n${
        sessions.length > 0
          ? sessions
              .map(digest => `### ${digest.project}${digest.title !== '' ? ` — ${digest.title}` : ''}\nPrompts:\n${digest.prompts.map(text => `- ${text}`).join('\n')}\nLast reply: ${digest.reply}`)
              .join('\n\n')
          : '(none)'
      }`,
    ].join('\n\n')
    const result = await $.model.complete({ model: 'sonnet', system: WRAP_SYSTEM, prompt, maxTokens: 1500 })
    if (!result.isAnswered) throw new Error(`the model gave no answer (${result.reason})`)
    const parsed = JSON.parse(result.text.slice(result.text.indexOf('{'), result.text.lastIndexOf('}') + 1)) as Partial<Wrap>
    const list = (value: unknown) => (Array.isArray(value) ? value.map(item => oneLine(String(item))).filter(item => item !== '') : [])
    wrap = { day: isoDay(now), done: list(parsed.done), open: list(parsed.open), tomorrow: list(parsed.tomorrow).slice(0, 3) }
    await $.store.set(`wrap:${wrap.day}`, wrap)
    wrapState = 'ready'
  } catch (error) {
    wrapState = 'error'
    wrapError = error instanceof Error ? error.message : String(error)
  }
  $.ui.invalidate('ui.render')
}

// The wrap as blocks for Craft's daily note; straight quotes become curly so the command stays one argument
async function saveWrap($: EngineInterface) {
  if (wrap === null) return
  const safe = (text: string) => text.replace(/'/g, '’')
  const stats = `${kpis?.today.prompts ?? 0} prompts · ${kpis?.today.focus ?? 0} focus blocks · ${kpis?.today.tasksDone ?? 0} tasks done · ${repos.reduce((sum, repo) => sum + repo.commitsToday.length, 0)} commits`
  const blocks = [
    `## End of day · ${stats}`,
    '**Done**',
    ...wrap.done.map(item => `- ${item}`),
    '**Open**',
    ...wrap.open.map(item => `- ${item}`),
    '**Tomorrow**',
    ...wrap.tomorrow.map(item => `- [ ] ${item}`),
  ].map(markdown => ({ type: 'text', markdown: safe(markdown) }))
  craftServer = await findServer($, 'craft_read', CRAFT)
  try {
    mcpText(await $.mcp.call(craftServer, 'craft_write', { command: `blocks add --date ${wrap.day} --json '${JSON.stringify(blocks)}'` }))
    wrapSaved = 'Saved to today’s Craft daily note.'
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    wrapSaved = /does not exist/i.test(message)
      ? 'Today’s Craft daily note does not exist yet. Open today in Craft once, then press s again.'
      : explainFailure('Craft', message, craftServer, ['craft_read', 'craft_write'])
  }
  $.ui.invalidate('ui.render')
}

// At the end of work hours, once a day: the wrap, with a chime. In the morning: yesterday's first next step
async function checkDay($: EngineInterface) {
  const now = await $.clock.now()
  const day = new Date(now)
  const today = isoDay(now)
  if (day.getDay() < 1 || day.getDay() > 5) return
  if (day.getHours() >= settings.endHour && (await $.store.get('wrapOfferedOn')) !== today) {
    if ((kpis?.today.prompts ?? 0) === 0) return
    await $.store.set('wrapOfferedOn', today)
    if (settings.sound) void chime($).catch(() => {})
    $.ui.toast('Day’s end. Your wrap is ready: /hud wrap')
    void loadWrap($)
    void $.ui.open({ id: WRAP_PANE, title: 'Today' }).catch(() => {})
    return
  }
  if (isWorkTime(now) && (await $.store.get('morningOn')) !== today) {
    await $.store.set('morningOn', today)
    const keys = (await $.store.keys()).filter(key => key.startsWith('wrap:') && key < `wrap:${today}`).sort()
    const last = keys.at(-1)
    const saved = last === undefined ? null : ((await $.store.get(last)) as Wrap | null)
    const first = saved?.tomorrow?.[0]
    if (first !== undefined) {
      $.ui.toast(`From your last wrap: ${first.slice(0, 80)}`)
      void $.prompt.suggest({ text: first }).catch(() => {})
    }
  }
}

let craftTasks: CraftTask[] = []
let craftState: 'never' | 'loading' | 'ready' | 'error' = 'never'
let craftError = ''
let craftAt = 0
let craftServer = CRAFT
// Craft's app link for a block, from connection info: craftdocs://open?spaceId=…&blockId={blockId}
let craftAppLink: string | null = null
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
    if (craftAppLink === null) {
      try {
        const info = JSON.parse(mcpText(await $.mcp.call(craftServer, 'craft_read', { command: 'connection info' })))
        const template = info?.urlTemplates?.app
        if (typeof template === 'string' && template.startsWith('craftdocs://') && template.includes('{blockId}')) craftAppLink = template
      } catch {}
    }
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

// Open a task in the Craft app; only craftdocs links for a real task id
async function openCraftTask($: EngineInterface, task: CraftTask) {
  if (craftAppLink === null) throw new Error('Craft gave no app link')
  if (!CRAFT_ID.test(task.id)) throw new Error('not a Craft task id')
  await openLink($, craftAppLink.replace('{blockId}', task.id))
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
        'Show or hide the session HUD band; /hud help lists everything; /hud tools, tasks, craft, kpi, next, git or wrap toggle a pane, /hud all every pane; /hud focus starts a focus block; /hud goal <n>, /hud idle <minutes|off>, /hud hours <9-19> set your KPIs; /hud update installs the latest version',
      argumentHint: '[help|all|tools|tasks|craft|kpi|next|git|wrap|focus n|goal n|idle m|hours a-b|sound on/off/test|update]',
    })
    isHidden = (await $.store.get('isHidden')) === true
    const saved = await $.store.get('settings')
    if (saved !== null && typeof saved === 'object') settings = { ...DEFAULT_SETTINGS, ...(saved as Partial<Settings>) }
    sessionId = await $.session.id().catch(() => 'session')
    await readFocus($).catch(() => {})
    const cached = (await $.store.get('suggestions')) as { at?: number; list?: Suggestion[] } | null
    if (cached !== null && typeof cached === 'object' && Array.isArray(cached.list)) {
      suggestions = cached.list
      suggestAt = cached.at ?? 0
      suggestState = 'ready'
    }
    void pruneKpis($).catch(() => {})
    void recordUsage($)
    void refreshGit($)
    // Keep the cost and context figures fresh
    $.clock.every(5000, async () => {
      if ([...lanes.values()].some(lane => isActive(lane.status))) void refreshAgents($)
      // Keep the tasks fresh while their pane is open
      if (tasksState !== 'loading' && (await $.clock.now()) - tasksAt > 5 * MINUTE) {
        if ((await $.ui.panes()).some(pane => pane.id === TASKS_PANE)) void loadTasks($)
      }
      const tick = await $.clock.now()
      void checkFocus($).catch(() => {})
      if (Math.floor(tick / MINUTE) !== Math.floor((tick - 5000) / MINUTE)) {
        void checkIdle($).catch(() => {})
        void checkDay($).catch(() => {})
        if (reposState !== 'loading' && tick - reposAt > 5 * MINUTE && (await $.ui.panes()).some(pane => pane.id === GIT_PANE)) void loadRepos($)
        if ((await $.ui.panes()).some(pane => pane.id === KPI_PANE)) void loadKpis($).catch(() => {})
        if (Math.floor(tick / MINUTE) % 5 === 0) void recordUsage($)
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
    const [verb = '', value = ''] = e.args.trim().split(/\s+/)
    if (verb === 'help') {
      const panes = await $.ui.panes()
      if (panes.some(pane => pane.id === HELP_PANE)) {
        await $.ui.close({ id: HELP_PANE })
        return { text: 'Help closed.' }
      }
      await $.ui.open({ id: HELP_PANE, title: 'Help' })
      return { text: 'HUD help opened.' }
    }
    if (verb === 'git') {
      const panes = await $.ui.panes()
      if (panes.some(pane => pane.id === GIT_PANE)) {
        await $.ui.close({ id: GIT_PANE })
        return { text: 'Git pane closed.' }
      }
      void loadRepos($)
      const opened = await $.ui.open({ id: GIT_PANE, title: 'Git' })
      return { text: opened.isPlaced ? 'Git pane opened.' : 'Git pane opens once the terminal is wider.' }
    }
    if (verb === 'wrap') {
      const panes = await $.ui.panes()
      if (panes.some(pane => pane.id === WRAP_PANE)) {
        await $.ui.close({ id: WRAP_PANE })
        return { text: 'Wrap closed.' }
      }
      const today = isoDay(await $.clock.now())
      if (wrap?.day !== today) {
        const saved = (await $.store.get(`wrap:${today}`)) as Wrap | null
        if (saved !== null && typeof saved === 'object') {
          wrap = saved
          wrapState = 'ready'
          void loadKpis($).catch(() => {})
        } else if (wrapState !== 'loading') void loadWrap($)
      }
      const opened = await $.ui.open({ id: WRAP_PANE, title: 'Today' })
      return { text: opened.isPlaced ? 'Today’s wrap opened.' : 'The wrap opens once the terminal is wider.' }
    }
    if (verb === 'focus') {
      if (value === 'stop') {
        await stopFocus($)
        return { text: 'Focus timer stopped.' }
      }
      if (value !== '' && !/^\d+$/.test(value)) return { text: 'Use /hud focus, /hud focus 50 or /hud focus stop.' }
      const minutes = value === '' ? settings.focusMinutes : Math.min(240, Math.max(1, Number(value)))
      await startFocus($, minutes)
      return { text: `Focus for ${minutes} minutes, until ${formatClock(focus?.until ?? 0)}. Nudges stay quiet; a chime marks the end.` }
    }
    // Every pane at once: open the ones that are closed, or close them all when all are open
    if (verb === 'all') {
      const panes: { id: string; title: string; load?: () => void }[] = [
        { id: PANE, title: 'Tool calls' },
        { id: TASKS_PANE, title: 'Tasks', load: () => void loadTasks($) },
        { id: CRAFT_PANE, title: 'Craft', load: () => void loadCraft($) },
        { id: KPI_PANE, title: 'KPIs', load: () => void loadKpis($).catch(() => {}) },
        { id: GIT_PANE, title: 'Git', load: () => void loadRepos($) },
        {
          id: NEXT_PANE,
          title: 'Next',
          load: () => {
            if (suggestState !== 'loading' && suggestState !== 'ready') void loadSuggestions($)
          },
        },
      ]
      const open = new Set((await $.ui.panes()).map(pane => pane.id))
      const closed = panes.filter(pane => !open.has(pane.id))
      if (closed.length === 0) {
        for (const pane of panes) await $.ui.close({ id: pane.id })
        return { text: 'All HUD panes closed.' }
      }
      for (const pane of closed) {
        pane.load?.()
        await $.ui.open({ id: pane.id, title: pane.title })
      }
      return { text: `Opened ${closed.map(pane => pane.title).join(', ')}. Run /hud all again to close them all.` }
    }
    if (verb === 'next') {
      const panes = await $.ui.panes()
      if (panes.some(pane => pane.id === NEXT_PANE)) {
        await $.ui.close({ id: NEXT_PANE })
        return { text: 'Next pane closed.' }
      }
      // Suggestions older than two hours are made again
      if (suggestState !== 'loading' && (suggestState !== 'ready' || (await $.clock.now()) - suggestAt > 2 * HOUR)) void loadSuggestions($)
      const opened = await $.ui.open({ id: NEXT_PANE, title: 'Next' })
      return { text: opened.isPlaced ? 'Next pane opened.' : 'Next pane opens once the terminal is wider.' }
    }
    if (verb === 'kpi') {
      const panes = await $.ui.panes()
      if (panes.some(pane => pane.id === KPI_PANE)) {
        await $.ui.close({ id: KPI_PANE })
        return { text: 'KPI pane closed.' }
      }
      void loadKpis($).catch(() => {})
      void recordUsage($)
      const opened = await $.ui.open({ id: KPI_PANE, title: 'KPIs' })
      return { text: opened.isPlaced ? 'KPI pane opened.' : 'KPI pane opens once the terminal is wider.' }
    }
    if (verb === 'sound') {
      if (value === 'test') {
        await chime($).catch(() => $.ui.toast('This terminal cannot play sounds.'))
        return { text: 'Played the nudge chime.' }
      }
      if (value !== 'on' && value !== 'off') return { text: 'Use /hud sound on, off or test.' }
      settings = { ...settings, sound: value === 'on' }
      await $.store.set('settings', settings)
      return { text: `Nudge chime ${value}.` }
    }
    if (verb === 'goal' || verb === 'idle' || verb === 'hours') {
      const next = { ...settings }
      if (verb === 'goal' && /^\d+$/.test(value) && Number(value) > 0) next.goal = Number(value)
      else if (verb === 'idle' && (value === 'off' || /^\d+$/.test(value))) next.idleMinutes = value === 'off' ? 0 : Number(value)
      else if (verb === 'hours' && /^\d{1,2}-\d{1,2}$/.test(value)) {
        const [start = 9, end = 19] = value.split('-').map(Number)
        if (start >= end || end > 24) return { text: 'Hours look like 9-19, start before end.' }
        next.startHour = start
        next.endHour = end
      } else {
        return { text: 'Use /hud goal 40, /hud idle 30 (or off), or /hud hours 9-19.' }
      }
      settings = next
      await $.store.set('settings', settings)
      void loadKpis($).catch(() => {})
      return {
        text: `Daily goal ${settings.goal} prompts · idle nudge ${settings.idleMinutes > 0 ? `after ${settings.idleMinutes}m${settings.sound ? ' with a chime' : ''}` : 'off'} · work hours ${settings.startHour}-${settings.endHour}, Mon-Fri.`,
      }
    }
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
    isTurnRunning = true
    // Count what you wrote: typed here, in the Desktop app or from Remote Control
    if (['composer', 'sdk', 'bridge'].includes(e.origin.kind)) {
      lastPromptAt = turnStartedAt
      const hour = new Date(turnStartedAt).getHours()
      void bumpToday($, record => {
        record.prompts += 1
        record.hours[hour] = (record.hours[hour] ?? 0) + 1
      })
        .then(() => $.store.set('lastPrompt', turnStartedAt))
        .then(() => loadKpis($))
        .catch(() => {})
    }
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
    isTurnRunning = false
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
        {focus !== null && (
          <Text color={focus.mode === 'focus' ? 'magenta' : 'green'}>
            {focus.mode === 'focus' ? '◷' : '☕'} {formatCountdown(focus.until - (await $.clock.now()))} {focus.mode}
          </Text>
        )}
        {focus !== null && sep}
        {kpis !== null && (
          <Text>
            <Text dimColor>✎ </Text>
            <Text color={kpis.today.prompts >= settings.goal ? 'green' : undefined}>
              {kpis.today.prompts}/{settings.goal}
            </Text>
          </Text>
        )}
        {kpis !== null && sep}
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
      void bumpToday($, record => (record.tasksDone += 1)).then(() => loadKpis($)).catch(() => {})
      $.ui.toast(`Done: ${task.text.slice(0, 60)}`)
      redraw()
    }

    const undo = async () => {
      const task = craftLastDone
      if (task === null) return
      await setCraftState($, task, 'todo')
      craftLastDone = null
      void bumpToday($, record => (record.tasksDone = Math.max(0, record.tasksDone - 1))).then(() => loadKpis($)).catch(() => {})
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
          const room = columns - (isArmed ? 22 : 16) - (craftAppLink !== null ? 8 : 0)
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
                {craftAppLink !== null && (
                  <Button
                    key={`craft-open-${task.id}`}
                    label="↗ open"
                    plain
                    dimColor
                    onPress={() => void openCraftTask($, task).catch(() => $.ui.toast('Could not open the task in Craft.'))}
                  />
                )}
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

  on('ui.render', { component: 'Pane', requestId: KPI_PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const now = await $.clock.now()
    if (kpis === null) return <Text dimColor>Adding up your KPIs…</Text>
    const today = kpis.today
    const activeHours = today.hours.filter(count => count > 0).length
    const perHour = activeHours > 0 ? today.prompts / activeHours : 0
    const hoursShown = today.hours.slice(settings.startHour - 1 < 0 ? 0 : settings.startHour - 1, Math.min(24, settings.endHour + 2))
    const firstHour = settings.startHour - 1 < 0 ? 0 : settings.startHour - 1
    const shared = await $.store.get('lastPrompt')
    const last = Math.max(lastPromptAt, typeof shared === 'number' ? shared : 0)
    const weekTotal = kpis.week.reduce((sum, day) => sum + day.prompts, 0)
    const daysSoFar = kpis.week.filter(day => day.day <= isoDay(now)).length
    const weekTasks = kpis.today.tasksDone

    const usage = await $.session.usage().catch(() => null)
    const seven = usage?.rateLimits.find(limit => limit.kind === 'seven_day')
    const five = usage?.rateLimits.find(limit => limit.kind === 'five_hour')
    const sevenPace = seven === undefined ? null : pace(seven.percentUsed, seven.resetsAt, 7 * 24 * HOUR, now)
    const fivePace = five === undefined ? null : pace(five.percentUsed, five.resetsAt, 5 * HOUR, now)
    const daysLeft = sevenPace === null ? 0 : sevenPace.left / (24 * HOUR)
    const perDay = seven === undefined || daysLeft <= 0 ? 0 : (100 - seven.percentUsed) / Math.max(1, daysLeft)

    const paceLine = (used: number, p: { elapsed: number; projected: number }) => {
      const ahead = used > p.elapsed
      return (
        <Text>
          <Text dimColor>  pace   </Text>
          <Text color={p.projected >= 100 ? (ahead ? 'yellow' : 'green') : 'cyan'}>
            {p.projected >= 100 ? 'on track to use it all' : `~${Math.round(p.projected)}% by reset, ${100 - Math.round(p.projected)}% unused`}
          </Text>
          <Text dimColor> · {ahead ? '▲ ahead of' : '▼ behind'} an even pace</Text>
        </Text>
      )
    }

    return (
      <Box flexDirection="column">
        <Text bold color="cyan">Today</Text>
        <Text>
          <Text dimColor>  prompts </Text>
          <Text color={today.prompts >= settings.goal ? 'green' : undefined}>
            {meter((today.prompts / settings.goal) * 100)} {today.prompts}/{settings.goal}
          </Text>
          <Text dimColor> · {perHour.toFixed(1)} per active hour · {activeHours}h active{today.focus > 0 ? ` · ${today.focus} focus block${today.focus === 1 ? '' : 's'}` : ''}</Text>
        </Text>
        <Text>
          <Text dimColor>  hours   </Text>
          {spark(hoursShown)}
          <Text dimColor> {firstHour}:00–{firstHour + hoursShown.length}:00</Text>
        </Text>
        <Text>
          <Text dimColor>  last    </Text>
          {last > 0 ? `${formatSpan(now - last)} ago` : 'no prompt yet'}
          <Text dimColor> · nudge {settings.idleMinutes > 0 ? `after ${settings.idleMinutes}m idle, ${settings.startHour}-${settings.endHour} Mon-Fri` : 'off'}</Text>
        </Text>
        {weekTasks > 0 && (
          <Text>
            <Text dimColor>  done    </Text>
            {weekTasks} Craft task{weekTasks === 1 ? '' : 's'}
          </Text>
        )}

        <Text bold color="cyan">This week</Text>
        <Text>
          <Text dimColor>  prompts </Text>
          {weekTotal}
          <Text dimColor> · {(weekTotal / Math.max(1, daysSoFar)).toFixed(0)} a day · streak {kpis.streak} day{kpis.streak === 1 ? '' : 's'} at goal</Text>
        </Text>
        {kpis.week.map(day => (
          <Text>
            <Text dimColor>  {new Date(`${day.day}T12:00:00`).toLocaleDateString('en-US', { weekday: 'short' })} </Text>
            <Text color={day.day === isoDay(now) ? 'green' : undefined}>
              {'▇'.repeat(Math.min(20, Math.round((day.prompts / Math.max(1, settings.goal)) * 10)))}
            </Text>
            <Text dimColor>
              {' '}
              {day.day > isoDay(now) ? '' : `${day.prompts}`}
              {day.usage !== null ? ` · ${Math.round(day.usage)}% of week` : ''}
            </Text>
          </Text>
        ))}

        {seven !== undefined && sevenPace !== null && (
          <Box flexDirection="column">
            <Text bold color="cyan">
              Weekly limit <Text dimColor>· resets in {formatSpan(sevenPace.left)}</Text>
            </Text>
            <Text>
              <Text dimColor>  used   </Text>
              <Text color={levelColor(seven.percentUsed)}>{meter(seven.percentUsed)} {Math.round(seven.percentUsed)}%</Text>
              <Text dimColor> · week {Math.round(sevenPace.elapsed)}% gone</Text>
            </Text>
            {paceLine(seven.percentUsed, sevenPace)}
            <Text>
              <Text dimColor>  budget </Text>
              {perDay.toFixed(0)}% a day to use the rest
            </Text>
          </Box>
        )}
        {five !== undefined && fivePace !== null && (
          <Box flexDirection="column">
            <Text bold color="cyan">
              5-hour limit <Text dimColor>· resets in {formatSpan(fivePace.left)}</Text>
            </Text>
            <Text>
              <Text dimColor>  used   </Text>
              <Text color={levelColor(five.percentUsed)}>{meter(five.percentUsed)} {Math.round(five.percentUsed)}%</Text>
              <Text dimColor> · window {Math.round(fivePace.elapsed)}% gone</Text>
            </Text>
            {paceLine(five.percentUsed, fivePace)}
          </Box>
        )}
        {kpis.weeks.length > 0 && (
          <Text>
            <Text dimColor>  past weeks </Text>
            {kpis.weeks.map(value => `${Math.round(value)}%`).join(' · ')}
          </Text>
        )}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: NEXT_PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const now = await $.clock.now()
    const here = await $.session.cwd().catch(() => '')

    // Put the suggestion in the prompt box; one from another project says where it belongs
    const pick = async (one: Suggestion) => {
      const line = one.cwd !== '' && one.cwd !== here ? `(for ${one.project}, ${one.cwd}) ${one.prompt}` : one.prompt
      const box = await $.prompt.read()
      await $.prompt.fill(box.text.trim() === '' ? { text: line } : { text: ` ${line}`, mode: 'append' })
    }

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" columnGap={2}>
          <Text dimColor wrap="truncate-end">
            {suggestState === 'loading'
              ? 'Reading your last 10 sessions…'
              : suggestState === 'error'
                ? 'Could not make suggestions'
                : suggestState === 'ready'
                  ? `From your last 10 sessions · ${formatSpan(now - suggestAt)} ago`
                  : 'No suggestions yet'}
          </Text>
          <Button key="next-refresh" label="refresh" hotkey="r" plain onPress={() => void loadSuggestions($)} />
        </Box>
        {suggestState === 'error' && <Text color="yellow" wrap="wrap">{suggestError}</Text>}
        {suggestions.map((one, index) => (
          <Box flexDirection="column">
            <Text bold color={one.cwd === here ? 'green' : 'cyan'}>
              {one.project !== '' ? one.project : 'session'}
              {one.cwd === here && <Text dimColor> · this project</Text>}
            </Text>
            <Button
              key={`next-${index}`}
              label={one.prompt}
              plain
              hotkey={String(index + 1)}
              onPress={() => void pick(one).catch(() => $.ui.toast('Could not put the prompt in the prompt box.'))}
            />
            {one.why !== '' && <Text dimColor wrap="truncate-end">{'   '}{one.why}</Text>}
          </Box>
        ))}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: GIT_PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const now = await $.clock.now()
    const fill = async (text: string) => {
      const box = await $.prompt.read()
      await $.prompt.fill(box.text.trim() === '' ? { text } : { text: ` ${text}`, mode: 'append' })
    }
    const busy = repos.filter(repo => repo.changed > 0 || repo.unpushed > 0 || repo.prs.length > 0)
    const clean = repos.length - busy.length
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" columnGap={2}>
          <Text dimColor wrap="truncate-end">
            {reposState === 'loading'
              ? 'Checking the repos you worked in this week…'
              : reposState === 'error'
                ? 'Could not check your repos'
                : `${busy.length} with work left · ${clean} clean · ${formatSpan(now - reposAt)} ago`}
          </Text>
          <Button key="git-refresh" label="refresh" hotkey="r" plain onPress={() => void loadRepos($)} />
        </Box>
        {reposState === 'error' && <Text color="yellow" wrap="wrap">{reposError}</Text>}
        {reposState === 'ready' && busy.length === 0 && <Text color="green">Everything is committed and pushed.</Text>}
        {busy.map(repo => (
          <Box flexDirection="column">
            <Text wrap="truncate-end">
              <Text bold color="cyan">{repo.name}</Text>
              <Text dimColor> ⎇ {repo.branch}</Text>
              {repo.commitsToday.length > 0 && <Text color="green"> · {repo.commitsToday.length} commits today</Text>}
            </Text>
            <Box flexDirection="row" columnGap={2} flexWrap="wrap">
              {repo.changed > 0 && (
                <Button
                  key={`git-commit-${repo.top}`}
                  label={`✎ ${repo.changed} uncommitted`}
                  plain
                  onPress={() => void fill(`In ${repo.top}: review the uncommitted changes on ${repo.branch}, then commit and push them.`).catch(() => {})}
                />
              )}
              {repo.unpushed > 0 && (
                <Button
                  key={`git-push-${repo.top}`}
                  label={`↑ ${repo.unpushed} unpushed`}
                  plain
                  onPress={() => void fill(`In ${repo.top}: push the ${repo.unpushed} unpushed commits on ${repo.branch}, and open a PR if there is none.`).catch(() => {})}
                />
              )}
              {repo.prs.map(pr => (
                <Button
                  key={`git-pr-${repo.top}-${pr.number}`}
                  label={`PR #${pr.number} ${pr.title.slice(0, 40)}`}
                  plain
                  onPress={() => void fill(`In ${repo.top}: review PR #${pr.number} (${pr.url}) and tell me what is left before merging.`).catch(() => {})}
                />
              ))}
            </Box>
          </Box>
        ))}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: WRAP_PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const now = await $.clock.now()
    const commits = repos.reduce((sum, repo) => sum + repo.commitsToday.length, 0)
    const pick = async (text: string) => {
      const box = await $.prompt.read()
      await $.prompt.fill(box.text.trim() === '' ? { text } : { text: ` ${text}`, mode: 'append' })
    }
    const section = (title: string, items: string[], color: string) =>
      items.length === 0 ? null : (
        <Box flexDirection="column">
          <Text bold color={color}>{title}</Text>
          {items.map(item => (
            <Text wrap="wrap">  • {item}</Text>
          ))}
        </Box>
      )
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" columnGap={2}>
          <Text bold>{new Date(now).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })}</Text>
          <Button key="wrap-refresh" label="refresh" hotkey="r" plain onPress={() => void loadWrap($)} />
          {wrap !== null && wrapState === 'ready' && (
            <Button key="wrap-save" label="save to Craft" hotkey="s" plain onPress={() => void saveWrap($).catch(() => {})} />
          )}
        </Box>
        <Text dimColor>
          {kpis?.today.prompts ?? 0} prompts · {kpis?.today.focus ?? 0} focus blocks · {kpis?.today.tasksDone ?? 0} tasks done · {commits} commits
        </Text>
        {wrapState === 'loading' && <Text dimColor>Writing your wrap from today’s sessions, commits and tasks…</Text>}
        {wrapState === 'error' && <Text color="yellow" wrap="wrap">Could not write the wrap: {wrapError}</Text>}
        {wrap !== null && wrapState === 'ready' && (
          <Box flexDirection="column">
            {section('Done', wrap.done, 'green')}
            {section('Open', wrap.open, 'yellow')}
            {wrap.tomorrow.length > 0 && <Text bold color="cyan">Tomorrow</Text>}
            {wrap.tomorrow.map((item, index) => (
              <Button key={`wrap-next-${index}`} label={item} plain hotkey={String(index + 1)} onPress={() => void pick(item).catch(() => {})} />
            ))}
          </Box>
        )}
        {wrapSaved !== '' && <Text color={wrapSaved.startsWith('Saved') ? 'green' : 'yellow'} wrap="wrap">{wrapSaved}</Text>}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: HELP_PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const row = (command: string, what: string) => (
      <Text wrap="wrap">
        <Text color="cyan">{command.padEnd(22)}</Text>
        <Text dimColor>{what}</Text>
      </Text>
    )
    return (
      <Box flexDirection="column">
        <Text bold>Panes</Text>
        {row('/hud all', 'open every pane, or close them all')}
        {row('/hud tools', 'tool calls with their reasons, subagent lanes')}
        {row('/hud tasks', 'your open ClickUp tasks')}
        {row('/hud craft', 'your Craft tasks, ✓ done twice to complete')}
        {row('/hud kpi', 'prompts, streak, weekly and 5-hour pace')}
        {row('/hud next', 'next prompts from your last 10 sessions')}
        {row('/hud git', 'uncommitted, unpushed and PRs across repos')}
        {row('/hud wrap', 'today’s wrap, save it to Craft')}
        {row('/hud help', 'this help')}
        <Text bold>Focus and nudges</Text>
        {row('/hud focus [min]', `start a focus block (default ${settings.focusMinutes}m, ${settings.breakMinutes}m break)`)}
        {row('/hud focus stop', 'stop the timer')}
        {row('/hud goal <n>', `daily prompt goal (now ${settings.goal})`)}
        {row('/hud idle <min|off>', `nudge after idle minutes (now ${settings.idleMinutes > 0 ? settings.idleMinutes : 'off'})`)}
        {row('/hud hours <a-b>', `work hours, Mon-Fri (now ${settings.startHour}-${settings.endHour})`)}
        {row('/hud sound on|off|test', `the chime (now ${settings.sound ? 'on' : 'off'})`)}
        <Text bold>Other</Text>
        {row('/hud', 'hide or show the band above the prompt')}
        {row('/hud update', 'install the latest version and reload')}
        <Text bold>Keys in a pane</Text>
        {row('Ctrl+X Tab', 'focus the pane; then number keys pick, r refreshes')}
        {row('Ctrl+X ↑ / ↓', 'make the pane bigger or smaller')}
        {row('Ctrl+X X', 'close the pane')}
      </Box>
    )
  })
}
