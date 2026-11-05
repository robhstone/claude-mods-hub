import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const PANE = {
  plugin: 'mods-hub',
  component: 'Pane',
  requestId: 'cache-tax',
  props: {
    title: 'Cache Tax',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

/** Stands in for the engine under the mod: a session with a 200k context on Fable 5.1. */
function engine(on: On, toasts: string[] = [], placed = true) {
  const clock = mock.clock(on, { now: 10 * 60 * 60 * 1000 })
  mock.store(on)
  mock.env(on, {})
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.model', () => ({ value: 'claude-fable-5-1' }))
  on('session.usage', () => ({ value: { context: { tokens: 200000 }, startedAt: 0 } }) as never)
  on('config.list', () => ({ value: [] }))
  on('command.register', () => ({ value: { command: 'x' } }) as never)
  on('command.list', () => ({ value: [] }))
  on('ui.open', () => ({ value: placed ? { isPlaced: true } : { isPlaced: false, reason: 'the attached surfaces (mobile) place no panes' } }) as never)
  on('ui.close', () => ({ value: undefined }) as never)
  on('ui.panes', () => ({ value: [] }) as never)
  // The engine's own row above the prompt, beneath the band.
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  on('ui.status', () => ({ value: undefined }) as never)
  on('prompt.compose', () => ({ sections: [] }))
  on('ui.log', () => ({ value: undefined }) as never)
  on('ui.toast', (_, e) => { toasts.push(String((e as { text?: string }).text ?? e)); return { value: undefined } as never })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.surfaces', () => ({ value: [] }))
  return clock
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`/cache-tax opens the panel on ${surface}`, async ($, on) => {
    engine(on)
    await $.session.start({ cwd: '/', surface, isInteractive: true })
    const r = await $.command.run({ command: 'cache-tax' } as never)
    expect(r.text).toMatch(/panel opened/)
    const status = await $.command.run({ command: 'cache-tax', args: 'status' } as never)
    expect(status.text).toMatch(/context\s+200,000 tokens/)
  })

  test(`the panel shows state and arms a window from a button on ${surface}`, async ($, on) => {
    const toasts: string[] = []
    engine(on, toasts)
    await $.session.start({ cwd: '/', surface, isInteractive: true })
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /UNKNOWN/ }))).toBeTruthy()
    expect((await ui.find({ type: 'Text', text: /\$4\.00 to re-write/ }))).toBeTruthy()

    await ui.press({ key: 'kw-90m' })
    expect(toasts.join('\n')).toMatch(/keepwarm on for 1h30m/)
    const status = await $.command.run({ command: 'keepwarm', args: 'status' } as never)
    expect(status.text).toMatch(/1h30m left/)

    await ui.press({ key: 'kw-off' })
    expect((await $.command.run({ command: 'keepwarm', args: 'status' } as never)).text).toBe('keepwarm is off')
    await ui.unmount()
  })

  test(`the guard buttons switch the mode on ${surface}`, async ($, on) => {
    const toasts: string[] = []
    engine(on, toasts)
    await $.session.start({ cwd: '/', surface, isInteractive: true })
    const ui = await $.ui.mount({ ...PANE, surface })
    const drawnText = JSON.stringify(await ui.drawn())
    expect(drawnText).toMatch(/resend to pay it/)

    await ui.press({ key: 'guard-warn' })
    expect(toasts.at(-1)).toMatch(/guard set to warn/)
    expect((await $.command.run({ command: 'cache-tax', args: 'status' } as never)).text).toMatch(/warn only/)
    expect(JSON.stringify(await ui.drawn())).toMatch(/Shows the price and sends/)

    await ui.press({ key: 'guard-refuse' })
    expect((await $.command.run({ command: 'cache-tax', args: 'status' } as never)).text).toMatch(/refuse once/)
    await ui.unmount()
  })
}

const BAND = {
  plugin: 'mods-hub',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const

const TURN = { answer: 'ok', turnId: 't1', isAborted: false, reason: 'answered', durationMs: 1000, usage: { model: 'claude-fable-5-1', input_tokens: 10, output_tokens: 10, cache_read_input_tokens: 200000, cache_creation_input_tokens: 0 } }

for (const surface of ['terminal', 'desktop'] as const) {
  test(`the Cache tab counts down, keeps warm and folds its details on ${surface}`, async ($, on) => {
    const toasts: string[] = []
    const clock = engine(on, toasts)
    on('turn.complete', () => ({ text: '' }))
    await $.session.start({ cwd: '/', surface, isInteractive: true })
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(JSON.stringify(await ui.drawn())).not.toMatch(/Cache Warm/)
    expect(JSON.stringify(await ui.drawn())).toMatch(/The hour starts when the first reply lands/)

    await $.turn.complete(TURN as never)
    expect(await ui.find({ type: 'Text', text: /^60m$/ })).toBeTruthy()
    expect(JSON.stringify(await ui.drawn())).toMatch(/200k tokens are read for \$0\.05 instead of re-written for \$4\.00/)
    await clock.advance(56 * 60 * 1000)
    expect(await ui.find({ type: 'Text', text: /^4:00$/ })).toBeTruthy()

    await ui.press({ key: 'band-keepwarm' })
    expect(toasts.at(-1)).toMatch(/keepwarm on for 6h00m/)
    expect(JSON.stringify(await ui.drawn())).toMatch(/Keeping Warm · 6h00m/)
    await ui.press({ key: 'band-keepwarm' })
    expect((await $.command.run({ command: 'keepwarm', args: 'status' } as never)).text).toBe('keepwarm is off')

    expect(JSON.stringify(await ui.drawn())).toMatch(/Each ping reads the chat/)
    await ui.press({ key: 'band-details' })
    expect(JSON.stringify(await ui.drawn())).not.toMatch(/Each ping reads the chat/)
    await ui.press({ key: 'band-details' })
    expect(JSON.stringify(await ui.drawn())).toMatch(/Each ping reads the chat/)

    await clock.advance(70 * 60 * 1000)
    expect(await ui.find({ type: 'Text', text: /Cache Cold/ })).toBeTruthy()
    expect(JSON.stringify(await ui.drawn())).toMatch(/re-writes 200k tokens for \$4\.00, and is held once/)
    await ui.unmount()
  })
}

test('where nothing draws, /cache-tax still answers with the text card', async ($, on) => {
  engine(on, [], false)
  await $.session.start({ cwd: '/', surface: 'mobile', isInteractive: true })
  const r = await $.command.run({ command: 'cache-tax' } as never)
  expect(r.text).toMatch(/guard\s+refuse once/)
  expect(r.text).toMatch(/panel not shown: the attached surfaces \(mobile\) place no panes/)
})

test('a cold send is still refused once, then goes through', async ($, on) => {
  const clock = engine(on)
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('turn.complete', () => ({ text: '' }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.complete({ answer: 'ok', turnId: 't1', isAborted: false, reason: 'answered', durationMs: 1000, usage: { model: 'claude-fable-5-1', input_tokens: 10, output_tokens: 10, cache_read_input_tokens: 200000, cache_creation_input_tokens: 0 } } as never)
  await clock.advance(2 * 60 * 60 * 1000)
  const first = await $.prompt.submit({ text: 'recap please', origin: { kind: 'user' } } as never)
  expect((first as { drop?: string }).drop).toMatch(/went cold/)
  const second = await $.prompt.submit({ text: 'recap please', origin: { kind: 'user' } } as never)
  expect((second as { drop?: string }).drop).toBeUndefined()
})
