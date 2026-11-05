import { expect, test } from 'claude-code/testing'

import { installArgs } from '../hooks/mods/skills'
import { AUTHORS, RECOMMENDED, SKILLS } from '../hooks/mods/skills-catalog'
import { engine } from './engine'

const BAND = {
  plugin: 'mods-hub',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 100, scroll: { offset: 0, bodyRows: 20 }, view: {} },
} as const

const PANE = {
  plugin: 'mods-hub',
  component: 'Pane',
  requestId: 'skills',
  props: { title: 'All Skills', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

// Theo's and Poteto's are copied in under their own names; Matt's come namespaced by his plugin.
const THEO = ['council', 'full-send']
const MATT = ['grill-with-docs', 'to-spec', 'to-tickets', 'retro']
const INSTALLED = [
  ...THEO.map(name => ({ name, description: '', source: 'user' })),
  ...MATT.map(name => ({ name: `mattpocock-skills:${name}`, description: '', source: 'plugin' })),
  { name: 'code-review', description: '', source: 'builtin' },
]

const drawn = async (ui: { drawn: () => Promise<unknown> }) => JSON.stringify(await ui.drawn())

function promptBox(on: Parameters<typeof engine>[0], start = '') {
  const box = { text: start, runs: [] as string[], refuse: false }
  on('prompt.read', () => ({ value: { text: box.text, cursor: box.text.length } }) as never)
  on('prompt.fill', (_, e) => {
    if (box.refuse) return { isFilled: false, text: box.text, cursor: 0 } as never
    box.text = e.text
    return { isFilled: true, text: e.text, cursor: e.text.length } as never
  })
  on('command.run', (_, e) => {
    box.runs.push(e.command)
    return { text: '' } as never
  })
  return box
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`favorites are chips, and Run fills the prompt with the picked one on ${surface}`, async ($, on) => {
    const toasts: string[] = []
    engine(on, toasts, INSTALLED)
    const box = promptBox(on)
    await $.session.start({ cwd: '/', surface, isInteractive: true })
    const ui = await $.ui.mount({ ...BAND, surface })
    await ui.press({ key: 'hub-tab-skills' })

    for (const id of ['council', 'grill-with-docs', 'to-spec', 'to-tickets', 'retro']) {
      expect(await ui.find({ key: `skills-chip-${id}` })).toBeTruthy()
    }
    // Council comes first, with its card and its Run in the header.
    expect(await drawn(ui)).toMatch(/Run Council/)
    expect(await drawn(ui)).toMatch(/Three read-only reviewers/)

    await ui.press({ key: 'skills-chip-grill-with-docs' })
    expect(await drawn(ui)).toMatch(/Run Grill with Docs/)
    expect(await drawn(ui)).toMatch(/GLOSSARY/)
    await ui.press({ key: 'skills-focus-run' })
    expect(box.text).toBe('/mattpocock-skills:grill-with-docs ')
    expect(toasts.at(-1)).toMatch(/in your prompt box/)
    await ui.unmount()
  })

  test(`the picked chip takes its slot's color, and the rest stay muted, on ${surface}`, async ($, on) => {
    engine(on, [], INSTALLED)
    promptBox(on)
    await $.session.start({ cwd: '/', surface, isInteractive: true })
    const ui = await $.ui.mount({ ...BAND, surface })
    await ui.press({ key: 'hub-tab-skills' })
    const colors = ['#FF8A65', '#F5C04E', '#6FCF97', '#6CB6FF', '#B794F6']
    const ids = ['council', 'grill-with-docs', 'to-spec', 'to-tickets', 'retro']
    for (const [slot, id] of ids.entries()) {
      await ui.press({ key: `skills-chip-${id}` })
      const tree = await drawn(ui)
      expect(tree).toContain(colors[slot]!)
      for (const [other, color] of colors.entries()) {
        if (other !== slot) expect(tree).not.toContain(color)
      }
    }
    await ui.unmount()
  })

  test(`All Skills opens the panel and becomes Close Panel, on ${surface}`, async ($, on) => {
    engine(on, [], INSTALLED)
    promptBox(on)
    await $.session.start({ cwd: '/', surface, isInteractive: true })
    const ui = await $.ui.mount({ ...BAND, surface })
    await ui.press({ key: 'hub-tab-skills' })
    expect(await ui.find({ key: 'skills-browse' })).toBeFalsy()
    expect((await ui.find({ key: 'hub-open' }))?.props?.label).toBe('All Skills')

    await ui.press({ key: 'hub-open' })
    expect((await ui.find({ key: 'hub-open' }))?.props?.label).toBe('Close Panel')

    await ui.press({ key: 'hub-open' })
    expect((await ui.find({ key: 'hub-open' }))?.props?.label).toBe('All Skills')

    // Opened by the command, the button says so too.
    await $.command.run({ command: 'skill-deck' } as never)
    expect((await ui.find({ key: 'hub-open' }))?.props?.label).toBe('Close Panel')
    await ui.unmount()
  })
}

test('Council carries its chosen members, and seats exactly three', async ($, on) => {
  const toasts: string[] = []
  engine(on, toasts, INSTALLED)
  const box = promptBox(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'hub-tab-skills' })
  expect(await drawn(ui)).toMatch(/☑ Claude Opus/)

  await ui.press({ key: 'skills-member-GPT Sol' })
  expect(toasts.at(-1)).toMatch(/untick one first/)

  await ui.press({ key: 'skills-member-Claude Sonnet' })
  await ui.press({ key: 'skills-focus-run' })
  expect(toasts.at(-1)).toMatch(/pick 3 first/)
  expect(box.text).toBe('')

  await ui.press({ key: 'skills-member-GPT Sol' })
  expect(await drawn(ui)).toMatch(/GPT Sol needs a tool/)
  await ui.press({ key: 'skills-focus-run' })
  expect(box.text).toBe('/council Use these council members, even though some share a provider: Claude Opus, Claude Fable, GPT Sol. ')

  // The choice carries over to the next session.
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  expect(await drawn(ui)).toMatch(/☑ GPT Sol/)
  await ui.unmount()
})

test('Run keeps what you typed, and a second press replaces only its own command', async ($, on) => {
  engine(on, [], INSTALLED)
  const box = promptBox(on, 'the login flow')
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'hub-tab-skills' })
  await ui.press({ key: 'skills-chip-to-spec' })
  await ui.press({ key: 'skills-focus-run' })
  expect(box.text).toBe('/mattpocock-skills:to-spec the login flow')
  await ui.press({ key: 'skills-chip-to-tickets' })
  await ui.press({ key: 'skills-focus-run' })
  expect(box.text).toBe('/mattpocock-skills:to-tickets the login flow')
  await ui.unmount()
})

test('Retro runs at once, and a closed prompt box says so', async ($, on) => {
  const toasts: string[] = []
  engine(on, toasts, INSTALLED)
  const box = promptBox(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'hub-tab-skills' })
  await ui.press({ key: 'skills-chip-retro' })
  await ui.press({ key: 'skills-focus-run' })
  expect(box.runs).toEqual(['mattpocock-skills:retro'])
  expect(box.text).toBe('')

  box.refuse = true
  await ui.press({ key: 'skills-chip-to-spec' })
  await ui.press({ key: 'skills-focus-run' })
  expect(toasts.at(-1)).toMatch(/Couldn't reach the prompt box/)
  await ui.unmount()
})

test('a skill that is missing points at the install button instead of running', async ($, on) => {
  const toasts: string[] = []
  engine(on, toasts, [{ name: 'code-review', description: '', source: 'builtin' }] as never)
  const box = promptBox(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'hub-tab-skills' })
  await ui.press({ key: 'skills-chip-to-spec' })
  expect(await drawn(ui)).toMatch(/Not installed/)
  await ui.unmount()

  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await pane.press({ key: 'skills-run-to-spec' })
  expect(toasts.at(-1)).toMatch(/Press Install Recommended Skills/)
  expect(box.text).toBe('')

  // One that needs more than the button says how to get it.
  await pane.press({ key: 'skills-run-sol-loop' })
  expect(toasts.at(-1)).toMatch(/Not part of the recommended set.*tstack/)

  // The built-in of the same name doesn't count as Matt's.
  await pane.press({ key: 'skills-run-code-review' })
  expect(toasts.at(-1)).toMatch(/Code Review isn't installed/)
  await pane.unmount()
})

test('the card never needs the hub to scroll, even with a warning', async ($, on) => {
  engine(on, [], INSTALLED)
  promptBox(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'hub-tab-skills' })
  await ui.press({ key: 'skills-member-Claude Sonnet' })
  await ui.press({ key: 'skills-member-GPT Sol' })
  const tree = await drawn(ui)
  expect(tree).toMatch(/Heads up/)
  expect(tree).not.toMatch(/\d–\d of \d/)
  expect(await ui.find({ key: 'hub-down' })).toBeFalsy()
  await ui.unmount()
})

test('a star in the panel adds a chip, remembered across sessions; no stars says what to do', async ($, on) => {
  engine(on, [], everything())
  promptBox(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await pane.press({ key: 'skills-star-interrogate' })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'hub-tab-skills' })
  expect(await drawn(ui)).toMatch(/6 favorites/)
  expect(await ui.find({ key: 'skills-chip-interrogate' })).toBeTruthy()

  for (const id of ['council', 'grill-with-docs', 'to-spec', 'to-tickets', 'retro', 'interrogate']) {
    await pane.press({ key: `skills-star-${id}` })
  }
  expect(await drawn(ui)).toMatch(/No favorites yet/)
  expect(await ui.find({ key: 'hub-open' })).toBeTruthy()
  await pane.unmount()
  await ui.unmount()
})

for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
  test(`the panel lists every skill by stage and opens its card on ${surface}`, async ($, on) => {
    engine(on, [], INSTALLED)
    promptBox(on)
    await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
    const pane = await $.ui.mount({ ...PANE, surface })
    for (const skill of SKILLS) expect(await pane.find({ key: `skills-run-${skill.id}` })).toBeTruthy()
    expect(await drawn(pane)).toMatch(/Reflect/)

    await pane.press({ key: 'skills-open-council' })
    expect(await drawn(pane)).toMatch(/Three read-only reviewers/)
    expect(await pane.find({ key: 'skills-member-Claude Opus' })).toBeTruthy()

    await pane.press({ key: 'skills-author-theo' })
    expect(await pane.find({ key: 'skills-run-council' })).toBeTruthy()
    expect(await pane.find({ key: 'skills-run-retro' })).toBeFalsy()
    await pane.unmount()
  })
}

test('every card is complete, and every id is unique', async () => {
  expect(new Set(SKILLS.map(s => s.id)).size).toBe(SKILLS.length)
  for (const skill of SKILLS) {
    expect(skill.line.length).toBeLessThanOrEqual(48)
    expect(skill.when.length).toBeGreaterThan(0)
    expect(skill.how.length).toBeGreaterThan(0)
  }
})

test('turned off, the command says so and the panel draws nothing to run', async ($, on) => {
  engine(on, [], INSTALLED)
  promptBox(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'hub-settings' })
  await ui.press({ key: 'hub-on-skills' })
  await ui.unmount()
  expect((await $.command.run({ command: 'skill-deck' } as never)).text).toMatch(/Skills is off/)
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await pane.find({ key: 'skills-run-council' })).toBeFalsy()
  await pane.unmount()
})

// ---------- Install Recommended Skills ----------

/** Everything the installer would add, as the engine would list it afterwards. */
const everything = () => RECOMMENDED.map(skill => {
  const plugin = AUTHORS[skill.author].plugin
  return plugin
    ? { name: `${plugin}:${skill.id}`, description: '', source: 'plugin' }
    : { name: skill.id, description: '', source: 'user' }
})

/** Stands in for the install script. `fail` names the repositories that won't download. */
function installer(on: Parameters<typeof engine>[0], fail: string[] = [], onRun?: () => void) {
  const runs: { argv: readonly string[]; env?: Record<string, string> }[] = []
  on('process.run', (_, e) => {
    runs.push({ argv: e.argv, env: e.init?.env })
    onRun?.()
    return { value: { exitCode: fail.some(repo => e.argv.includes(repo)) ? 1 : 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } as never
  })
  return runs
}

test('with nothing installed, one button replaces Run, and installs all three authors', async ($, on) => {
  const toasts: string[] = []
  const commands: unknown[] = []
  engine(on, toasts, commands)
  promptBox(on)
  const runs = installer(on, [], () => { if (commands.length === 0) commands.push(...everything()) })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'hub-tab-skills' })
  expect((await ui.find({ key: 'skills-install' }))?.props?.label).toBe('Install Recommended Skills')
  expect(await ui.find({ key: 'skills-focus-run' })).toBeFalsy()
  expect(await drawn(ui)).toContain(`0 of ${RECOMMENDED.length} recommended installed`)

  await ui.press({ key: 'skills-install' })
  expect(runs.map(run => run.argv[2])).toEqual(['plugin', 'copy', 'copy'])
  expect(runs[0]!.argv.at(-1)).toBe('mattpocock-skills')
  expect(runs[1]!.argv).toContain('leaving-pr-comments')
  expect(runs[2]!.env?.ON_DEMAND).toBe('how why')
  expect(toasts.at(-1)).toMatch(/installed and ready/)
  expect(await ui.find({ key: 'skills-install' })).toBeFalsy()
  expect(await ui.find({ key: 'skills-focus-run' })).toBeTruthy()
  await ui.unmount()
})

test('only what is missing is asked for, and the skills that need GPT Sol stay out', async () => {
  const theo = RECOMMENDED.filter(skill => skill.author === 'theo')
  const { argv } = installArgs('theo', theo.filter(skill => skill.id === 'council'))
  expect(argv.slice(4)).toEqual(['council', 'leaving-pr-comments'])
  for (const id of ['full-send', 'full-stop', 'sol-loop']) expect(RECOMMENDED.some(skill => skill.id === id)).toBe(false)
  for (const author of Object.values(AUTHORS)) expect(author.commit).toMatch(/^[0-9a-f]{40}$/)
})

test('a plugin already there counts whole, so an older copy never brings a second one', async ($, on) => {
  const others = everything().filter(c => c.source === 'user')
  engine(on, [], [...others, { name: 'mattpocock-skills:grill-me', description: '', source: 'plugin' }])
  promptBox(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'hub-tab-skills' })
  expect(await ui.find({ key: 'skills-install' })).toBeFalsy()
  await ui.unmount()
})

test('a failed author is named, the rest still install, and the button stays to retry', async ($, on) => {
  const toasts: string[] = []
  engine(on, toasts, [])
  promptBox(on)
  const runs = installer(on, ['t3dotgg/tstack'])
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'hub-tab-skills' })
  await ui.press({ key: 'skills-install' })
  expect(runs).toHaveLength(3)
  expect(toasts.at(-1)).toMatch(/Couldn't install Theo's skills/)
  expect(await drawn(ui)).toMatch(/Couldn't install Theo's skills/)
  expect(await ui.find({ key: 'skills-install' })).toBeTruthy()
  await ui.unmount()
})

test('installed, but not showing yet, says to start a new session rather than offer it again', async ($, on) => {
  const toasts: string[] = []
  engine(on, toasts, [])
  promptBox(on)
  installer(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'hub-tab-skills' })
  await ui.press({ key: 'skills-install' })
  expect(toasts.at(-1)).toMatch(/start a new session/)
  expect(await ui.find({ key: 'skills-install' })).toBeFalsy()
  await ui.unmount()
})

test('the panel offers the install too, for the surfaces with no band', async ($, on) => {
  engine(on, [], [])
  promptBox(on)
  const runs = installer(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const pane = await $.ui.mount({ ...PANE, surface: 'vscode' })
  await pane.press({ key: 'skills-install-pane' })
  expect(runs).toHaveLength(3)
  await pane.unmount()
})

// ---------- Existing ----------

const MINE = [
  ...INSTALLED,
  { name: 'impeccable', description: 'Design   better\nfrontends.', source: 'user' },
  { name: 'gsd:add-phase', description: 'Add a phase', source: 'user' },
  { name: 'figma:figma-use', description: 'Use Figma', source: 'plugin', plugin: 'figma' },
  { name: 'server:prompt', description: 'From MCP', source: 'mcp' },
  { name: 'clear', description: 'Built in', source: 'builtin' },
  { name: 'skill-deck', description: 'The hub', source: 'plugin', plugin: 'mods-hub' },
]

for (const surface of ['terminal', 'desktop'] as const) {
  test(`Existing lists skills beyond the catalog, grouped, on ${surface}`, async ($, on) => {
    engine(on, [], MINE)
    const box = promptBox(on)
    await $.session.start({ cwd: '/', surface, isInteractive: true })
    const pane = await $.ui.mount({ ...PANE, surface })
    expect((await pane.find({ key: 'skills-author-existing' }))?.props?.label).toBe('Existing 3')
    expect(await pane.find({ key: 'skills-run-impeccable' })).toBeFalsy()

    await pane.press({ key: 'skills-author-existing' })
    const tree = await drawn(pane)
    expect(tree).toContain('Your own skills')
    expect(tree).toContain('gsd')
    expect(tree).toContain('Add Phase')
    for (const key of ['skills-run-impeccable', 'skills-run-gsd:add-phase', 'skills-run-figma:figma-use']) {
      expect(await pane.find({ key })).toBeTruthy()
    }
    // Not a skill you added, and not one the catalog already has a card for.
    for (const key of ['skills-run-server:prompt', 'skills-run-clear', 'skills-run-skill-deck', 'skills-run-council']) {
      expect(await pane.find({ key })).toBeFalsy()
    }

    await pane.press({ key: 'skills-open-impeccable' })
    expect(await drawn(pane)).toContain('Design better frontends.')
    await pane.press({ key: 'skills-run-impeccable' })
    expect(box.text).toBe('/impeccable ')
    await pane.unmount()
  })
}

test('an existing skill can be a favorite, and drops out quietly if it goes away', async ($, on) => {
  const commands = [...MINE]
  engine(on, [], commands)
  const box = promptBox(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await pane.press({ key: 'skills-author-existing' })
  await pane.press({ key: 'skills-star-impeccable' })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'hub-tab-skills' })
  await ui.press({ key: 'skills-chip-impeccable' })
  const tree = await drawn(ui)
  expect(tree).toContain('Run Impeccable')
  expect(tree).toContain('Your own skills')
  await ui.press({ key: 'skills-focus-run' })
  expect(box.text).toBe('/impeccable ')

  commands.splice(commands.findIndex(c => c.name === 'impeccable'), 1)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  expect(await ui.find({ key: 'skills-chip-impeccable' })).toBeFalsy()
  await pane.unmount()
  await ui.unmount()
})

test('with nothing beyond the catalog, Existing says where skills come from', async ($, on) => {
  engine(on, [], INSTALLED)
  promptBox(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await pane.press({ key: 'skills-author-existing' })
  expect(await drawn(pane)).toMatch(/No other skills yet/)
  await pane.unmount()
})
