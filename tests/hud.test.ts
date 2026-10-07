import { expect, test } from 'claude-code/testing'

const BAND = {
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10 },
} as const

test('the band counts tool calls and /hud toggles it', async ($, on) => {
  on('session.usage', () => ({ value: {
    startedAt: 0,
    context: { tokens: 42000, window: 200000, percent: 21 },
    rateLimits: [{ kind: 'five_hour', percentUsed: 37 }],
    cost: { usd: 1.23 },
  } }))
  on('ui.render', ($, e) => $.ui.resolve(e).Box({ children: [] }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '' } }))
  const store = new Map<string, unknown>()
  on('store.get', (_, e) => ({ value: store.get(e.key) }))
  on('store.set', (_, e) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('tool.call', () => ({ result: { text: 'ok' } }))

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'session-hud', surface, ...BAND })
    expect(await ui.find({ type: 'Text', text: /tools/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /\$1\.23/ })).toBeDefined()
    await ui.unmount()
  }

  await $.tool.call({ tool: 'Read', file_path: '/tmp/x' })
  const counted = await $.ui.mount({ plugin: 'session-hud', surface: 'terminal', ...BAND })
  expect(await counted.find({ type: 'Text', text: /Read 1/ })).toBeDefined()
  await counted.unmount()

  await $.command.run({ command: 'hud', args: '' })
  const hidden = await $.ui.mount({ plugin: 'session-hud', surface: 'terminal', ...BAND })
  expect(await hidden.find({ type: 'Text', text: /tools/ })).toBeUndefined()
  await hidden.unmount()
})
