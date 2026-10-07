import { expect, mock, test } from 'claude-code/testing'

const line = (entry: Record<string, unknown>) => JSON.stringify(entry)
const TRANSCRIPT = [
  'partial line from the cut',
  line({ type: 'custom-title', customTitle: 'Login fixes' }),
  line({ type: 'user', cwd: '/work/shop', gitBranch: 'fix-login', origin: { kind: 'human' }, message: { content: 'fix the login redirect' } }),
  line({ type: 'user', isMeta: true, message: { content: 'Base directory for this skill: /tmp/skill' } }),
  line({ type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } }),
  line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Fixed it. Want me to add a test for the redirect?' }] } }),
].join('\n')

test('/hud next suggests prompts from your recent sessions and a press fills one in', async ($, on) => {
  mock.clock(on, { now: 10 * 3600_000 })
  mock.store(on)
  on('env.get', () => ({ value: '/home/me' }))
  on('fs.list', (_, e) =>
    e.path === '/home/me/.claude/projects'
      ? { value: [{ name: '-work-shop', kind: 'dir', size: 0, mtimeMs: 0, isLink: false }] }
      : { value: [{ name: 'abc.jsonl', kind: 'file', size: 10, mtimeMs: 9 * 3600_000, isLink: false }] },
  )
  on('process.run', (_, e) =>
    e.argv[0] === 'tail' ? { value: { exitCode: 0, stdout: TRANSCRIPT, stderr: '' } } : { value: { exitCode: 1, stdout: '', stderr: '' } },
  )
  let asked = ''
  on('model.complete', (_, e) => {
    asked = String(e.prompt)
    return {
      value: {
        isAnswered: true,
        text: '```json\n[{"project":"shop","prompt":"Add a test for the login redirect","why":"Claude offered it"}]\n```',
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    }
  })
  on('session.cwd', () => ({ value: '/elsewhere' }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  let filled = ''
  on('prompt.read', () => ({ value: { text: '', cursor: 0 } }))
  on('prompt.fill', (_, e) => {
    filled = e.text
    return { isFilled: true }
  })

  await $.command.run({ command: 'hud', args: 'next' })
  const pane = await $.ui.mount({ plugin: 'session-hud', surface: 'terminal', component: 'Pane', requestId: 'hud-next', props: {} })

  // Only your own prompt and Claude's reply reach the model, with the project and branch
  expect(asked).toMatch(/shop \(fix-login\) — Login fixes/)
  expect(asked).toMatch(/- fix the login redirect/)
  expect(asked).not.toMatch(/Base directory/)
  expect(asked).toMatch(/Want me to add a test/)

  expect(await pane.find({ type: 'Text', text: /^shop$/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /Claude offered it/ })).toBeDefined()
  await pane.press({ key: 'next-0' })
  expect(filled).toBe('(for shop, /work/shop) Add a test for the login redirect')
  await pane.unmount()
})
