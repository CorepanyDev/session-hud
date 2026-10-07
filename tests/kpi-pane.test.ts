import { expect, mock, test } from 'claude-code/testing'

// Wednesday 7 October 2026, 10:00 local time
const WEDNESDAY_10 = new Date(2026, 9, 7, 10, 0, 0).getTime()

const setup = (on: Parameters<Parameters<typeof test>[1]>[1], now = WEDNESDAY_10) => {
  const clock = mock.clock(on, { now })
  mock.store(on)
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { tokens: 0, window: 200000, percent: 0 },
      rateLimits: [{ kind: 'seven_day', percentUsed: 30, resetsAt: new Date(now + 3.5 * 24 * 3600_000).toISOString() }],
    },
  }))
  on('session.id', () => ({ value: 's1' }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '' } }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('prompt.suggest', () => ({ isShown: true }))
  on('turn.complete', (_, e) => ({ text: e.text }))
  const toasts: string[] = []
  on('ui.toast', (_, e) => {
    toasts.push(String(e.text))
    return { value: undefined }
  })
  return { clock, toasts }
}

test('your typed prompts count toward the daily goal; plugin prompts do not', async ($, on) => {
  setup(on)
  await $.command.run({ command: 'hud', args: 'goal 4' })
  await $.prompt.submit({ text: 'one', origin: { kind: 'composer' } })
  await $.prompt.submit({ text: 'two', origin: { kind: 'composer' } })
  await $.prompt.submit({ text: 'from a plugin', origin: { kind: 'plugin', name: 'other' } })

  await $.command.run({ command: 'hud', args: 'kpi' })
  const pane = await $.ui.mount({ plugin: 'session-hud', surface: 'terminal', component: 'Pane', requestId: 'hud-kpi', props: {} })
  expect(await pane.find({ type: 'Text', text: /2\/4/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /2\.0 per active hour/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /Weekly limit/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /30%/ })).toBeDefined()
  await pane.unmount()
})

test('/hud goal, idle and hours change the settings and say so', async ($, on) => {
  setup(on)
  expect((await $.command.run({ command: 'hud', args: 'goal 50' })).text).toMatch(/Daily goal 50/)
  expect((await $.command.run({ command: 'hud', args: 'idle off' })).text).toMatch(/idle nudge off/)
  expect((await $.command.run({ command: 'hud', args: 'hours 8-17' })).text).toMatch(/work hours 8-17/)
  expect((await $.command.run({ command: 'hud', args: 'hours 18-9' })).text).toMatch(/start before end/)
  expect((await $.command.run({ command: 'hud', args: 'goal lots' })).text).toMatch(/Use \/hud goal/)
})

test('a quiet half hour in work hours brings one nudge, not one per minute', async ($, on) => {
  const { clock, toasts } = setup(on)
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/tmp', surface: 'terminal' })
  await $.command.run({ command: 'hud', args: 'idle 30' })
  await $.prompt.submit({ text: 'start', origin: { kind: 'composer' } })
  await $.turn.complete({ reason: 'end_turn', text: 'done' } as never)

  await clock.advance(20 * 60_000)
  expect(toasts.filter(text => /No prompt/.test(text))).toEqual([])

  await clock.advance(11 * 60_000)
  expect(toasts.filter(text => /No prompt for/.test(text)).length).toBe(1)

  await clock.advance(5 * 60_000)
  expect(toasts.filter(text => /No prompt for/.test(text)).length).toBe(1)
})

test('no nudge outside work hours', async ($, on) => {
  const { clock, toasts } = setup(on, new Date(2026, 9, 7, 21, 0, 0).getTime())
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/tmp', surface: 'terminal' })
  await clock.advance(90 * 60_000)
  expect(toasts.filter(text => /No prompt/.test(text))).toEqual([])
})
