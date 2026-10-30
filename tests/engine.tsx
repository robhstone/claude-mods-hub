import { mock } from 'claude-code/testing'
import type { On } from 'claude-code'

/** Stands in for the engine under the hub: a desktop session with a 200k context on Fable 5.1. */
export function engine(on: On, toasts: string[] = []) {
  const clock = mock.clock(on, { now: 10 * 60 * 60 * 1000 })
  mock.store(on)
  mock.env(on, {})
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.model', () => ({ value: 'claude-fable-5-1' }))
  on('session.usage', () => ({ value: { context: { tokens: 200000 }, startedAt: 0 } }) as never)
  on('config.list', () => ({ value: [] }))
  on('command.register', () => ({ value: { command: 'x' } }) as never)
  on('command.list', () => ({ value: [] }))
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.close', () => ({ value: undefined }) as never)
  // The engine's own row above the prompt, beneath the hub.
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  on('ui.status', () => ({ value: undefined }) as never)
  on('ui.log', () => ({ value: undefined }) as never)
  on('ui.toast', (_, e) => { toasts.push(String((e as { text?: string }).text ?? e)); return { value: undefined } as never })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.surfaces', () => ({ value: [] }))
  on('turn.complete', () => ({ text: '' }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('prompt.compose', () => ({ sections: [] }))
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: `a${++spawned}` }))
  let spawned = 0
  return clock
}
