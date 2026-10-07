import { expect, mock, test } from 'claude-code/testing'

const LIST = `Tasks (active): 3 result(s)

[ ] <11111111-1111-4111-8111-111111111111> - [ ] Book the dentist [project: home]
  (deadline: 2026-09-30)
  in: inbox

[ ] <22222222-2222-4222-8222-222222222222> - [ ] Water the plants
  (schedule: 2026-10-07)
  in: Weekly plan <44444444-4444-4444-8444-444444444444>

[ ] <33333333-3333-4333-8333-333333333333> - [ ] Read the new book
  in: inbox
`

const setup = (on: Parameters<Parameters<typeof test>[1]>[1]) => {
  mock.clock(on, { now: new Date('2026-10-07T12:00:00').getTime() })
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
  on('ui.toast', () => ({ value: undefined }))
  on('tool.list', () => ({ value: [{ name: 'mcp__craft__craft_read', description: 'Read Craft', mcp: true }] }))
  const writes: string[] = []
  on('mcp.call', (_, e) => {
    const command = String(e.args.command ?? '')
    if (e.tool === 'craft_write') writes.push(`${e.server} ${command}`)
    const text =
      command === 'connection info'
        ? JSON.stringify({ urlTemplates: { app: 'craftdocs://open?spaceId=space-1&blockId={blockId}' } })
        : e.tool === 'craft_read'
          ? LIST
          : 'Updated'
    return { value: { content: [{ type: 'text', text }], isError: false } }
  })
  return { writes, opened }
}

test('/hud craft groups your Craft tasks by overdue, today and no date', async ($, on) => {
  setup(on)
  const reply = await $.command.run({ command: 'hud', args: 'craft' })
  expect(reply.text).toMatch(/Craft pane opened/)

  const pane = await $.ui.mount({ plugin: 'session-hud', surface: 'terminal', component: 'Pane', requestId: 'hud-craft', props: {} })
  expect(await pane.find({ type: 'Text', text: /3 active/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /^overdue / })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /^today / })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /^no date / })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /due Sep 30/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /^home$/ })).toBeDefined()
  // The weekly planner's id is dropped from where it lives
  expect(await pane.find({ type: 'Text', text: /^Weekly plan$/ })).toBeDefined()
  await pane.unmount()
})

test('marking a Craft task done takes two presses and can be undone', async ($, on) => {
  const { writes } = setup(on)
  await $.command.run({ command: 'hud', args: 'craft' })
  const pane = await $.ui.mount({ plugin: 'session-hud', surface: 'terminal', component: 'Pane', requestId: 'hud-craft', props: {} })

  const id = '11111111-1111-4111-8111-111111111111'
  await pane.press({ key: `craft-done-${id}` })
  expect(writes).toEqual([])
  expect(await pane.find({ type: 'Button', text: /press again/ })).toBeDefined()

  await pane.press({ key: `craft-done-${id}` })
  expect(writes).toEqual([`craft tasks update --task ${id} --state done`])
  expect(await pane.find({ type: 'Text', text: /2 active/ })).toBeDefined()

  await pane.press({ key: 'craft-undo' })
  expect(writes).toEqual([`craft tasks update --task ${id} --state done`, `craft tasks update --task ${id} --state todo`])
  expect(await pane.find({ type: 'Text', text: /3 active/ })).toBeDefined()
  await pane.unmount()
})

test('the open button opens a Craft task in the Craft app', async ($, on) => {
  const { opened } = setup(on)
  await $.command.run({ command: 'hud', args: 'craft' })
  const pane = await $.ui.mount({ plugin: 'session-hud', surface: 'terminal', component: 'Pane', requestId: 'hud-craft', props: {} })
  await pane.press({ key: 'craft-open-11111111-1111-4111-8111-111111111111' })
  expect(opened).toEqual(['craftdocs://open?spaceId=space-1&blockId=11111111-1111-4111-8111-111111111111'])
  await pane.unmount()
})
