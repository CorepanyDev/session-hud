import { expect, mock, test } from 'claude-code/testing'

// Wednesday 7 October 2026, 10:00 local time
const WEDNESDAY_10 = new Date(2026, 9, 7, 10, 0, 0).getTime()
type On = Parameters<Parameters<typeof test>[1]>[1]

const base = (on: On, now = WEDNESDAY_10) => {
  const clock = mock.clock(on, { now })
  mock.store(on)
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 0, window: 200000, percent: 0 }, rateLimits: [] } }))
  on('session.id', () => ({ value: 's1' }))
  on('session.cwd', () => ({ value: '/work/shop' }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('prompt.suggest', () => ({ isShown: true }))
  on('audio.play', () => ({ value: undefined }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  const toasts: string[] = []
  on('ui.toast', (_, e) => {
    toasts.push(String(e.text))
    return { value: undefined }
  })
  return { clock, toasts }
}

const transcript = (cwd: string) => JSON.stringify({ type: 'user', cwd, origin: { kind: 'human' }, message: { content: 'ship the cart' } })

// A fake machine: sessions in /work/shop and two of its worktrees, with changes, a commit and one PR
const WORKTREE_A = '/work/shop/.claude/worktrees/dreamy-a1'
const WORKTREE_B = '/work/shop/.claude/worktrees/clean-b2'
const machine = (on: On) => {
  on('env.get', () => ({ value: '/home/me' }))
  on('fs.list', (_, e) =>
    e.path === '/home/me/.claude/projects'
      ? { value: [{ name: '-work-shop', kind: 'dir', size: 0, mtimeMs: 0, isLink: false }] }
      : {
          value: ['a', 'b', 'c'].map(name => ({ name: `${name}.jsonl`, kind: 'file', size: 10, mtimeMs: WEDNESDAY_10 - 3600_000, isLink: false })),
        },
  )
  const gh: string[] = []
  on('process.run', (_, e) => {
    const argv = e.argv.join(' ')
    const out = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '' } })
    if (argv.startsWith('tail')) {
      const cwd = argv.includes('a.jsonl') ? '/work/shop' : argv.includes('b.jsonl') ? WORKTREE_A : WORKTREE_B
      return out(`cut\n${transcript(cwd)}`)
    }
    const at = e.argv[2] ?? ''
    if (argv.includes('--show-toplevel')) return out(`${at}\n`)
    if (argv.includes('--git-common-dir')) return out('/work/shop/.git\n')
    if (argv.includes('--abbrev-ref')) return out(at === '/work/shop' ? 'cart\n' : at === WORKTREE_A ? 'fix/checkout-total\n' : 'docs\n')
    if (argv.includes('status --porcelain')) return out(at === '/work/shop' ? ' M a.ts\n M b.ts\n' : '')
    if (argv.includes('--not --remotes')) return out(at === WORKTREE_A ? '3\n' : '0\n')
    if (argv.includes('user.email')) return out('me@example.com\n')
    if (argv.includes(' log ')) return out('Add the cart page\n')
    if (argv.startsWith('gh pr list')) {
      gh.push(argv)
      return out(JSON.stringify([{ number: 12, title: 'Cart page', url: 'https://github.com/x/shop/pull/12' }]))
    }
    return out('', 1)
  })
  return { gh }
}

test('/hud focus counts down in the band, chimes into a break and counts the block', async ($, on) => {
  const { clock, toasts } = base(on)
  await $.session.start({ cwd: '/tmp', surface: 'terminal' })
  expect((await $.command.run({ command: 'hud', args: 'focus 25' })).text).toMatch(/Focus for 25 minutes, until 10:25/)

  const band = { plugin: 'session-hud', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 10 } } as const
  const during = await $.ui.mount(band)
  expect(await during.find({ type: 'Text', text: /◷ 25:00 focus/ })).toBeDefined()
  await during.unmount()

  await clock.advance(25 * 60_000 + 5000)
  expect(toasts.some(text => /Focus block done \(25m\)\. Break until 10:30/.test(text))).toBe(true)
  const pause = await $.ui.mount(band)
  expect(await pause.find({ type: 'Text', text: /☕ .* break/ })).toBeDefined()
  await pause.unmount()

  await clock.advance(5 * 60_000 + 5000)
  expect(toasts.some(text => /Break's over/.test(text))).toBe(true)
  expect((await $.command.run({ command: 'hud', args: 'focus soon' })).text).toMatch(/Use \/hud focus/)
})

test('/hud git groups worktrees under their repo, asks GitHub once, and a press fills the prompt', async ($, on) => {
  base(on)
  const { gh } = machine(on)
  let filled = ''
  on('prompt.read', () => ({ value: { text: '', cursor: 0 } }))
  on('prompt.fill', (_, e) => {
    filled = e.text
    return { isFilled: true }
  })
  await $.command.run({ command: 'hud', args: 'git' })
  const pane = await $.ui.mount({ plugin: 'session-hud', surface: 'terminal', component: 'Pane', requestId: 'hud-git', props: {} })
  expect(await pane.find({ type: 'Text', text: /1 repo with work left/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /^shop$/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /1 commit today/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /1 open PR/ })).toBeDefined()
  expect(await pane.find({ type: 'Button', text: /✎ 2 to commit/ })).toBeDefined()
  expect(await pane.find({ type: 'Button', text: /↑ 3 to push/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /\+ 1 clean checkout/ })).toBeDefined()
  expect(gh).toHaveLength(1)
  await pane.press({ key: `git-push-${WORKTREE_A}` })
  expect(filled).toBe(`In ${WORKTREE_A}: push the 3 unpushed commits on fix/checkout-total, and open a PR if there is none.`)
  await pane.press({ key: 'git-pr-/work/shop-12' })
  expect(filled).toBe('In /work/shop: review PR #12 (https://github.com/x/shop/pull/12) and tell me what is left before merging.')
  await pane.unmount()
})

test('/hud wrap writes the day from sessions and commits, and saves it to the Craft daily note', async ($, on) => {
  base(on)
  machine(on)
  let asked = ''
  on('model.complete', (_, e) => {
    asked = String(e.prompt)
    return {
      value: {
        isAnswered: true,
        text: JSON.stringify({ done: ["Shipped the cart's page"], open: ['PR #12 waits for review'], tomorrow: ['Merge PR #12', 'Add cart tests'] }),
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    }
  })
  on('tool.list', () => ({ value: [{ name: 'mcp__craft__craft_read', description: 'Read', mcp: true }] }))
  const writes: string[] = []
  on('mcp.call', (_, e) => {
    writes.push(String(e.args.command))
    return { value: { content: [{ type: 'text', text: 'Added' }], isError: false } }
  })

  await $.command.run({ command: 'hud', args: 'wrap' })
  const pane = await $.ui.mount({ plugin: 'session-hud', surface: 'terminal', component: 'Pane', requestId: 'hud-wrap', props: {} })
  expect(asked).toMatch(/shop: Add the cart page/)
  expect(asked).toMatch(/- ship the cart/)
  expect(asked).toMatch(/shop \(cart, fix\/checkout-total\): 2 changed files, 3 unpushed commits, open PRs #12 Cart page/)
  expect(await pane.find({ type: 'Text', text: /Shipped the cart’s page|Shipped the cart's page/ })).toBeDefined()
  expect(await pane.find({ type: 'Button', text: /Merge PR #12/ })).toBeDefined()

  await pane.press({ key: 'wrap-save' })
  expect(writes).toHaveLength(1)
  expect(writes[0]).toMatch(/^blocks add --date 2026-10-07 --json '\[/)
  // Straight quotes become curly, so the JSON stays one quoted argument
  expect(writes[0]).toMatch(/cart’s page/)
  expect((writes[0] ?? '').slice(0, -1)).not.toMatch(/'.*'.*'/s)
  expect(await pane.find({ type: 'Text', text: /Saved to today’s Craft daily note/ })).toBeDefined()
  await pane.unmount()
})

test('/hud help lists the commands', async ($, on) => {
  base(on)
  await $.command.run({ command: 'hud', args: 'help' })
  const pane = await $.ui.mount({ plugin: 'session-hud', surface: 'terminal', component: 'Pane', requestId: 'hud-help', props: {} })
  for (const command of ['/hud all', '/hud git', '/hud wrap', '/hud focus stop', '/hud sound on|off|test']) {
    expect(await pane.find({ type: 'Text', text: new RegExp(command.replace(/[|]/g, '\\|')) })).toBeDefined()
  }
  await pane.unmount()
})
