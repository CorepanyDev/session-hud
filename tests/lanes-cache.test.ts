import { expect, mock, test } from 'claude-code/testing'

const BAND = {
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10 },
} as const

const PANE = { plugin: 'session-hud', surface: 'terminal', component: 'Pane', requestId: 'hud-tools', props: {} } as const

test('a subagent gets its own lane with its type, task and calls', async ($, on) => {
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 0, window: 200000, percent: 0 }, rateLimits: [] } }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '' } }))
  on('session.messages', () => ({ value: [] }))
  on('agent.list', () => ({ value: [{ id: 'a1', type: 'Explore', description: 'Find the HUD code', status: 'running' }] }))
  on('tool.call', () => ({ result: { text: 'ok' } }))

  await $.tool.call({ tool: 'Read', tool_use_id: 'm1', file_path: '/tmp/main.ts' })
  await $.tool.call({ tool: 'Grep', tool_use_id: 's1', pattern: 'hud', agentId: 'a1' })

  const pane = await $.ui.mount(PANE)
  expect(await pane.find({ type: 'Text', text: /^Explore$/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /Find the HUD code/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /1 calls, running/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /^Main session$/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /\/tmp\/main\.ts/ })).toBeDefined()
  await pane.unmount()
})

test('a finished subagent keeps its lane heading in a short pane', async ($, on) => {
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 0, window: 200000, percent: 0 }, rateLimits: [] } }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '' } }))
  on('session.messages', () => ({ value: [] }))
  on('agent.list', () => ({ value: [{ id: 'a2', type: 'Explore', description: 'Find the pane', status: 'completed' }] }))
  on('tool.call', () => ({ result: { text: 'ok' } }))

  for (const tool of ['Read', 'Bash', 'Grep', 'Agent']) {
    await $.tool.call({ tool, tool_use_id: `m-${tool}`, description: `main ${tool}` })
  }
  for (let i = 0; i < 5; i++) {
    await $.tool.call({ tool: 'Grep', tool_use_id: `s${i}`, pattern: `p${i}`, agentId: 'a2' })
  }

  const pane = await $.ui.mount({ ...PANE, viewport: { columns: 60, rows: 10 } })
  expect(await pane.find({ type: 'Text', text: /^Explore$/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /5 calls/ })).toBeDefined()
  await pane.unmount()
})

test('the band counts down the prompt cache and says when it went cold', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 84000, window: 200000, percent: 42 }, rateLimits: [] } }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '' } }))
  let cacheRead = 0
  on('turn.step', async function* (_, e) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      stopReason: 'end_turn',
      usage: { model: 'm', input_tokens: 1, output_tokens: 1, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: 10 },
    }
  })

  const step = async () => {
    const stream = $.turn.step({ turnId: 't', index: 0, model: 'm', messageCount: 1 })
    for await (const _ of stream) {
      // drain
    }
    await stream.result
  }
  const band = async () => $.ui.mount({ plugin: 'session-hud', surface: 'terminal', ...BAND })

  // No subscription limits, so a five-minute cache
  await step()
  const warm = await band()
  expect(await warm.find({ type: 'Text', text: /warm 5m/ })).toBeDefined()
  await warm.unmount()

  await clock.advance(6 * 60_000)
  const cold = await band()
  expect(await cold.find({ type: 'Text', text: /^cold$/ })).toBeDefined()
  expect(await cold.find({ type: 'Text', text: /rewrites 84k tokens/ })).toBeDefined()
  await cold.unmount()

  // A cache read after six idle minutes shows the cache lives an hour
  cacheRead = 5000
  await step()
  const hour = await band()
  expect(await hour.find({ type: 'Text', text: /warm 60m/ })).toBeDefined()
  await hour.unmount()
})
