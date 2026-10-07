import { expect, mock, test } from 'claude-code/testing'

const TASKS = {
  tasks: [
    { id: 't1', name: 'Write the release notes', status: 'needs clarification', url: 'https://app.clickup.com/t/t1', priority: 'high', due_date: null, list: { name: 'Backlog' } },
    { id: 't2', name: 'Fix the login page', status: 'in progress', url: 'https://app.clickup.com/t/t2', priority: null, due_date: '1000', list: { name: 'Backlog' } },
  ],
  has_more: false,
}

test('/hud tasks lists your ClickUp tasks and a press puts one in the prompt', async ($, on) => {
  mock.clock(on, { now: 5000 })
  mock.store(on)
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 0, window: 200000, percent: 0 }, rateLimits: [] } }))
  const opened: string[] = []
  on('process.run', (_, e) => {
    if (e.argv[0] === 'open') {
      opened.push(e.argv[1] ?? '')
      return { value: { exitCode: 0, stdout: '', stderr: '' } }
    }
    return { value: { exitCode: 1, stdout: '', stderr: '' } }
  })
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const calls: string[] = []
  on('mcp.call', (_, e) => {
    calls.push(e.tool)
    const body = e.tool === 'clickup_resolve_assignees' ? { userIds: ['42'] } : TASKS
    return { value: { content: [{ type: 'text', text: JSON.stringify(body) }], isError: false } }
  })
  let filled = ''
  on('prompt.read', () => ({ value: { text: '', cursor: 0 } }))
  on('prompt.fill', (_, e) => {
    filled = e.text
    return { isFilled: true }
  })

  const reply = await $.command.run({ command: 'hud', args: 'tasks' })
  expect(reply.text).toMatch(/Tasks pane opened/)

  const pane = await $.ui.mount({ plugin: 'session-hud', surface: 'terminal', component: 'Pane', requestId: 'hud-tasks', props: {} })
  expect(calls).toEqual(['clickup_resolve_assignees', 'clickup_filter_tasks'])
  expect(await pane.find({ type: 'Text', text: /2 open/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /^in progress$/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /^needs clarification$/ })).toBeDefined()
  // Overdue due date and priority on the meta line
  expect(await pane.find({ type: 'Text', text: /due / })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /high/ })).toBeDefined()

  // In progress sorts first, so the login task has hotkey 1
  await pane.press({ key: 'task-t2' })
  expect(filled).toBe('Work on ClickUp task "Fix the login page" (https://app.clickup.com/t/t2).')

  // The open button opens the task's link, not the prompt
  await pane.press({ key: 'open-t2' })
  expect(opened).toEqual(['https://app.clickup.com/t/t2'])
  await pane.unmount()
})

test('the tasks pane says so when ClickUp is not reachable', async ($, on) => {
  mock.clock(on, { now: 0 })
  mock.store(on, { clickupUser: '42' })
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 0, window: 200000, percent: 0 }, rateLimits: [] } }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '' } }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('mcp.call', () => ({ value: { content: [{ type: 'text', text: 'not connected' }], isError: true } }))

  await $.command.run({ command: 'hud', args: 'tasks' })
  const pane = await $.ui.mount({ plugin: 'session-hud', surface: 'terminal', component: 'Pane', requestId: 'hud-tasks', props: {} })
  expect(await pane.find({ type: 'Text', text: /ClickUp: not connected/ })).toBeDefined()
  await pane.unmount()
})

test('the tasks pane finds the ClickUp server by its tools, whatever it is named', async ($, on) => {
  mock.clock(on, { now: 0 })
  mock.store(on, { clickupUser: '42' })
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 0, window: 200000, percent: 0 }, rateLimits: [] } }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '' } }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('tool.list', () => ({ value: [
    { name: 'Read', description: 'Reads a file', mcp: false },
    { name: 'mcp__ClickUp__clickup_filter_tasks', description: 'Filter tasks', mcp: true },
  ] }))
  const servers: string[] = []
  on('mcp.call', (_, e) => {
    servers.push(e.server)
    if (e.server !== 'ClickUp') {
      return { value: { content: [{ type: 'text', text: `no connected MCP tool "${e.tool}" on a server named "${e.server}"` }], isError: true } }
    }
    return { value: { content: [{ type: 'text', text: JSON.stringify({ tasks: [], has_more: false }) }], isError: false } }
  })

  await $.command.run({ command: 'hud', args: 'tasks' })
  const pane = await $.ui.mount({ plugin: 'session-hud', surface: 'desktop', component: 'Pane', requestId: 'hud-tasks', props: {} })
  expect(servers).toEqual(['ClickUp'])
  expect(await pane.find({ type: 'Text', text: /No open tasks/ })).toBeDefined()
  await pane.unmount()
})

test('the tasks pane explains a missing ClickUp connection', async ($, on) => {
  mock.clock(on, { now: 0 })
  mock.store(on, { clickupUser: '42' })
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 0, window: 200000, percent: 0 }, rateLimits: [] } }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '' } }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('tool.list', () => ({ value: [{ name: 'mcp__claude_ai_Gmail__search_threads', description: 'Search mail', mcp: true }] }))
  on('mcp.call', (_, e) => ({
    value: { content: [{ type: 'text', text: `no connected MCP tool "${e.tool}" on a server named "${e.server}"` }], isError: true },
  }))

  await $.command.run({ command: 'hud', args: 'tasks' })
  const pane = await $.ui.mount({ plugin: 'session-hud', surface: 'desktop', component: 'Pane', requestId: 'hud-tasks', props: {} })
  expect(await pane.find({ type: 'Text', text: /ClickUp is not connected in this session/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /MCP servers this session has: claude_ai_Gmail/ })).toBeDefined()
  await pane.unmount()
})

test('the tasks pane explains an auto mode refusal with the rules to add', async ($, on) => {
  mock.clock(on, { now: 0 })
  mock.store(on, { clickupUser: '42' })
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 0, window: 200000, percent: 0 }, rateLimits: [] } }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '' } }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('tool.list', () => ({ value: [{ name: 'mcp__clickup__clickup_filter_tasks', description: 'Filter tasks', mcp: true }] }))
  on('mcp.call', () => ({
    value: { content: [{ type: 'text', text: 'The server-side auto mode classifier gave no verdict for mcp__clickup__clickup_filter_tasks' }], isError: true },
  }))

  await $.command.run({ command: 'hud', args: 'tasks' })
  const pane = await $.ui.mount({ plugin: 'session-hud', surface: 'desktop', component: 'Pane', requestId: 'hud-tasks', props: {} })
  expect(await pane.find({ type: 'Text', text: /Auto mode blocked the ClickUp call/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /mcp__clickup__clickup_filter_tasks/ })).toBeDefined()
  await pane.unmount()
})
