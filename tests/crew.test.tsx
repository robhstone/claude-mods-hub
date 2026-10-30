import { expect, test } from 'claude-code/testing'

import { engine } from './engine'

const PANE = {
  plugin: 'mods-hub',
  component: 'Pane',
  requestId: 'crew',
  props: {
    title: 'Progress',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const BAND = {
  plugin: 'mods-hub',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: true,
    maxRows: 10,
    bodyColumns: 80,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

test('a sub-agent shows as a card with its purpose and steps, on every surface', async ($, on) => {
  // Nothing sits beneath the plugin: each hook here stands for the engine.
  engine(on)
  const notes: { agentId?: string; text: string }[] = []
  on('session.append', async (_, e, next) => {
    if (e.door === 'note') notes.push({ agentId: e.agentId, text: JSON.stringify(e.message.content) })
    return next(e)
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  await $.agent.spawn({
    tool_use_id: 't0',
    prompt: 'Why: Explore is fast at scanning many files without editing them.\nFind the login code.',
    description: 'Research',
    subagentType: 'Explore',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'claude-opus-5-5',
    background: false,
    fork: false,
  })
  await $.session.append({
    message: {
      type: 'assistant',
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'u1', name: 'Read', input: { file_path: '/src/session.ts' } }],
    },
    door: 'response',
    origin: { kind: 'model', model: 'claude-opus-5-5' },
    uuid: 'r1',
    agentId: 'a1',
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /Research/ }))?.text).toBe('Research')
    expect(await ui.find({ type: 'Text', text: /Why: Explore is fast/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Step 1 · Reading session\.ts/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Running · 1/ })).toBeDefined()
    await ui.unmount()

    const band = await $.ui.mount({ ...BAND, surface })
    expect(JSON.stringify(await band.drawn())).toMatch(/●1/)
    await band.press({ key: 'hub-tab-crew' })
    expect(JSON.stringify(await band.drawn())).toMatch(/1 working/)
    expect(JSON.stringify(await band.drawn())).toMatch(/● Research.*· Reading session\.ts/)
    await band.press({ key: 'hub-open' })
    await band.press({ key: 'hub-tab-cache-tax' })
    await band.unmount()
  }

  // Hovering a step reveals its details; the text is in the tree, hidden until then.
  const detail = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await detail.find({ type: 'Text', text: /Step 1 · Reading session\.ts · in progress/ })).toBeDefined()
  expect(await detail.find({ type: 'Text', text: /new tokens · .* re-read from cache/ })).toBeDefined()

  // Wrap up tells the running agent to finish with what it has.
  await detail.press({ key: 'wrap-a1' })
  expect(notes[0]?.agentId).toBe('a1')
  expect(notes[0]?.text).toMatch(/good enough/)
  expect(await detail.find({ type: 'Text', text: /Wrapping up · Step 1/ })).toBeDefined()
  await detail.unmount()

  await $.turn.complete({ answer: 'done', durationMs: 1000, isAborted: false, turnId: 'x', agentId: 'a1', reason: 'answer' })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Done · 1 step$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Finished · 1/ })).toBeDefined()
  await ui.unmount()
})

test('the plan checklist follows TodoWrite', async ($, on) => {
  engine(on)

  await $.session.append({
    message: {
      type: 'assistant',
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'p1',
          name: 'TodoWrite',
          input: {
            todos: [
              { content: 'Research audience', status: 'completed', activeForm: 'Researching' },
              { content: 'Write script', status: 'in_progress', activeForm: 'Writing' },
            ],
          },
        },
      ],
    },
    door: 'response',
    origin: { kind: 'model', model: 'claude-opus-5-5' },
    uuid: 'r2',
  })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Plan · 1 of 2 done/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Write script/ })).toBeDefined()
  await ui.unmount()
})
