import { expect, mock, test } from 'claude-code/testing'

test('/hud tools opens a pane listing each tool call with its reason', async ($, on) => {
  on('session.usage', () => ({ value: {
    startedAt: 0,
    context: { tokens: 0, window: 200000, percent: 0 },
    rateLimits: [],
  } }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '' } }))
  on('session.messages', () => ({ value: [
    { role: 'user', text: 'what changed?', toolUses: [] },
    {
      role: 'assistant',
      text: 'Let me look at the repo.\nChecking the working tree first.',
      toolUses: [{ tool_use_id: 't1', tool: 'Bash', input: { command: 'git status' } }],
    },
  ] }))
  on('tool.call', () => ({ result: { text: 'ok' } }))

  on('ui.panes', () => ({ value: [] }))
  on('skill.prompt', (_, e) => ({ text: e.text }))
  on('ui.open', () => ({ value: { isPlaced: true } }))

  const reply = await $.command.run({ command: 'hud', args: 'tools' })
  expect(reply.text).toMatch(/opened/)

  await $.tool.call({ tool: 'Bash', tool_use_id: 't1', command: 'git status', description: 'Show working tree status' })

  const pane = await $.ui.mount({ plugin: 'session-hud', surface: 'terminal', component: 'Pane', requestId: 'hud-tools', props: {} })
  expect(await pane.find({ type: 'Text', text: /Show working tree status/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /Checking the working tree first\./ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /✓/ })).toBeDefined()
  await pane.unmount()

  // A second Bash call joins the Bash group; a typed /name skill lands under Skills
  await $.tool.call({ tool: 'Bash', tool_use_id: 't2', command: 'ls', description: 'List files' })
  await $.skill.prompt({ skill: 'commit', text: 'Write a commit' })

  const grouped = await $.ui.mount({ plugin: 'session-hud', surface: 'terminal', component: 'Pane', requestId: 'hud-tools', props: {} })
  expect(await grouped.find({ type: 'Text', text: /^Bash$/ })).toBeDefined()
  expect(await grouped.find({ type: 'Text', text: /×2/ })).toBeDefined()
  expect(await grouped.find({ type: 'Text', text: /^Skills$/ })).toBeDefined()
  expect(await grouped.find({ type: 'Text', text: /by you/ })).toBeDefined()
  await grouped.unmount()
})

test('/hud update installs the newest version and reloads plugins', async ($, on) => {
  const ran: string[] = []
  const reloads: string[] = []
  on('process.run', (_, e) => {
    ran.push(e.argv.join(' '))
    const stdout = e.argv.includes('marketplace')
      ? '✔ Successfully updated marketplace: session-hud'
      : '✔ Plugin "session-hud" updated from 0.3.0 to 0.4.0 for scope user. Restart to apply changes.'
    return { value: { exitCode: 0, stdout, stderr: '' } }
  })
  on('command.run', (_, e) => {
    reloads.push(e.command)
    return { text: 'Reloaded' }
  })

  const reply = await $.command.run({ command: 'hud', args: 'update' })
  expect(reply.text).toMatch(/updated from 0\.3\.0 to 0\.4\.0/)
  expect(reply.text).not.toMatch(/\.\./)
  expect(ran).toContain('claude plugin marketplace update session-hud')
  expect(ran).toContain('claude plugin update session-hud@session-hud')
})

test('/hud all opens the closed panes, and closes them all when all are open', async ($, on) => {
  mock.clock(on, { now: 0 })
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 0, window: 200000, percent: 0 }, rateLimits: [] } }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '' } }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('store.keys', () => ({ value: [] }))
  on('tool.list', () => ({ value: [] }))
  on('mcp.call', () => ({ value: { content: [{ type: 'text', text: 'not connected' }], isError: true } }))
  on('env.get', () => ({ value: undefined }))
  const open = new Set<string>(['hud-tools'])
  on('ui.panes', () => ({ value: [...open].map(id => ({ id, title: id, isShown: true, isFocused: false, isPlaced: true })) }))
  on('ui.open', (_, e) => {
    open.add(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.close', (_, e) => {
    open.delete(e.id)
    return { value: undefined }
  })

  const opened = await $.command.run({ command: 'hud', args: 'all' })
  expect(opened.text).toBe('Opened Tasks, Craft, KPIs, Next. Run /hud all again to close them all.')
  expect([...open].sort()).toEqual(['hud-craft', 'hud-kpi', 'hud-next', 'hud-tasks', 'hud-tools'])

  const closed = await $.command.run({ command: 'hud', args: 'all' })
  expect(closed.text).toBe('All HUD panes closed.')
  expect([...open]).toEqual([])
})
