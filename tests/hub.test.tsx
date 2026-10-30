import { expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { engine } from './engine'

const BAND = {
  plugin: 'mods-hub',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 100, scroll: { offset: 0, bodyRows: 20 }, view: {} },
} as const

const TURN = { answer: 'ok', turnId: 't1', isAborted: false, reason: 'answered', durationMs: 1000, usage: { model: 'claude-fable-5-1', input_tokens: 10, output_tokens: 10, cache_read_input_tokens: 200000, cache_creation_input_tokens: 0 } }

const drawn = async (ui: { drawn: () => Promise<unknown> }) => JSON.stringify(await ui.drawn())

async function spawn($: Parameters<TestBody>[0], name: string) {
  await $.agent.spawn({
    tool_use_id: `t-${name}`,
    prompt: `Why: it is quick.\nDo ${name}.`,
    description: name,
    subagentType: 'Explore',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'claude-opus-5-5',
    background: false,
    fork: false,
  })
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`the hub shows a tab per favorite and switches between them on ${surface}`, async ($, on) => {
    engine(on)
    await $.session.start({ cwd: '/', surface, isInteractive: true })
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ key: 'hub-tab-cache-tax' })).toBeTruthy()
    expect(await ui.find({ key: 'hub-tab-crew' })).toBeTruthy()
    expect(await ui.find({ key: 'hub-more' })).toBeTruthy()
    expect(await ui.find({ key: 'hub-settings' })).toBeTruthy()
    // Cache is selected first: its headline, and its pane one press away as Open Panel.
    expect(await drawn(ui)).toMatch(/The hour starts when the first reply lands/)
    expect(await ui.find({ key: 'hub-open' })).toBeTruthy()

    await ui.press({ key: 'hub-tab-crew' })
    expect(await drawn(ui)).toMatch(/Nothing in progress/)

    await $.turn.complete(TURN as never)
    await ui.press({ key: 'hub-tab-cache-tax' })
    expect(await ui.find({ type: 'Text', text: /Cache Warm/ })).toBeTruthy()
    await ui.unmount()
  })
}

test('collapsing keeps the headline and the bar, and is remembered', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.complete(TURN as never)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await drawn(ui)).toMatch(/Reply now/)
  await ui.press({ key: 'hub-fold' })
  expect(await drawn(ui)).not.toMatch(/Reply now/)
  expect(await drawn(ui)).toMatch(/Cache Warm/)
  expect(await ui.find({ key: 'band-keepwarm' })).toBeTruthy()
  expect(await ui.find({ key: 'hub-tab-cache-tax' })).toBeTruthy()
  // The next session starts collapsed too.
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  expect(await drawn(ui)).not.toMatch(/Reply now/)
  // Picking a tab opens it again.
  await ui.press({ key: 'hub-tab-cache-tax' })
  expect(await drawn(ui)).toMatch(/Reply now/)
  await ui.unmount()
})

test('settings turn a mod fully off, and back on, across sessions', async ($, on) => {
  const toasts: string[] = []
  const clock = engine(on, toasts)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'hub-settings' })
  expect(await drawn(ui)).toMatch(/2 of 4 favorites/)
  await ui.press({ key: 'hub-on-cache-tax' })
  expect(toasts.at(-1)).toMatch(/Cache is off/)

  // Off means off: the commands say so and a cold send goes through unguarded.
  expect((await $.command.run({ command: 'keepwarm' } as never)).text).toMatch(/Cache is off/)
  await $.turn.complete(TURN as never)
  await clock.advance(2 * 60 * 60 * 1000)
  const sent = await $.prompt.submit({ text: 'recap please', origin: { kind: 'user' } } as never)
  expect((sent as { drop?: string }).drop).toBeUndefined()

  // The tab stays, showing that it's off.
  await ui.press({ key: 'hub-tab-cache-tax' })
  expect(await drawn(ui)).toMatch(/Cache is off/)

  // A new session remembers the switch.
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  expect((await $.command.run({ command: 'keepwarm' } as never)).text).toMatch(/Cache is off/)

  await ui.press({ key: 'hub-turnon-cache-tax' })
  expect((await $.command.run({ command: 'keepwarm', args: 'status' } as never)).text).toBe('keepwarm is off')
  await ui.unmount()
})

test('Progress turned off adds no Why line to the prompt and tracks nothing', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const compose = { model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: ['desktop'], tools: ['Agent'], outputStyle: null, traits: [], sections: [] } as never
  const before = await $.prompt.compose(compose)
  expect(JSON.stringify(before)).toMatch(/crew:why/)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'hub-settings' })
  await ui.press({ key: 'hub-on-crew' })
  const after = await $.prompt.compose(compose)
  expect(JSON.stringify(after)).not.toMatch(/crew:why/)

  await spawn($, 'Research')
  await ui.press({ key: 'hub-tab-crew' })
  expect(await drawn(ui)).toMatch(/Progress is off/)
  await ui.press({ key: 'hub-turnon-crew' })
  expect(await drawn(ui)).toMatch(/Nothing in progress/)
  await ui.unmount()
})

test('unstarring drops a tab; ⋯ opens any mod as a tab of its own until another is picked', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'hub-settings' })
  await ui.press({ key: 'hub-fav-crew' })
  expect(await drawn(ui)).toMatch(/1 of 4 favorites/)
  await ui.press({ key: 'hub-done' })
  expect(await ui.find({ key: 'hub-tab-crew' })).toBeFalsy()

  await ui.press({ key: 'hub-more' })
  expect(await ui.find({ key: 'hub-menu-crew' })).toBeTruthy()
  expect(await ui.find({ key: 'hub-menu-cache-tax' })).toBeTruthy()
  await ui.press({ key: 'hub-menu-crew' })
  expect(await ui.find({ key: 'hub-tab-crew' })).toBeTruthy()
  expect(await drawn(ui)).toMatch(/Nothing in progress/)

  await ui.press({ key: 'hub-tab-cache-tax' })
  expect(await ui.find({ key: 'hub-tab-crew' })).toBeFalsy()
  await ui.unmount()
})

test('/mods opens the settings', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const r = await $.command.run({ command: 'mods' } as never)
  expect(r.text).toMatch(/settings are open/)
  expect(await ui.find({ key: 'hub-on-crew' })).toBeTruthy()
  await ui.unmount()
})

test('a tab not in view gets a badge, and a tall mod scrolls in a window of five rows', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  for (const name of ['One', 'Two', 'Three', 'Four', 'Five', 'Six']) await spawn($, name)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  // Cache selected: Progress's tab shows six agents working.
  expect(await drawn(ui)).toMatch(/●6/)

  await ui.press({ key: 'hub-tab-crew' })
  // The agents' dots head it, then a line per agent: six rows, five shown.
  expect(await drawn(ui)).toMatch(/1–5 of 6/)
  expect(await drawn(ui)).not.toMatch(/● Six/)
  await ui.press({ key: 'hub-down' })
  expect(await drawn(ui)).toMatch(/2–6 of 6/)
  expect(await drawn(ui)).toMatch(/● Six/)
  await ui.press({ key: 'hub-down' })
  expect(await drawn(ui)).toMatch(/2–6 of 6/)
  await ui.press({ key: 'hub-up' })
  expect(await drawn(ui)).toMatch(/1–5 of 6/)
  await ui.unmount()
})
