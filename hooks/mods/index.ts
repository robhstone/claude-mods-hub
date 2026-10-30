import type { EngineInterface, On } from 'claude-code'

import type { ArgOf, BandInput, Badge, Mod, ModView, NextOf } from '../hub'
import {
  cacheTax, cacheTaxBadge, cacheTaxClassicSessionStart, cacheTaxDisable, cacheTaxEnable, cacheTaxOpenPane, cacheTaxPromptSubmit,
  cacheTaxSessionAttach, cacheTaxSessionCompact, cacheTaxSessionEnd, cacheTaxSessionStart, cacheTaxTurnComplete, cacheTaxTurnStep,
  cacheTaxUiClose, cacheTaxView, registerCacheTax,
} from './cache-tax'
import {
  crew, crewAgentSpawn, crewBadge, crewDisable, crewOpenPane, crewPromptCompose, crewPromptSubmit, crewSessionAppend,
  crewSessionMeasure, crewTurnComplete, crewTurnStep, crewView, registerCrew,
} from './crew'

// Adding a mod: write hooks/mods/<name>.tsx, then wire it in here: its entry in
// MODS, its register in registerMods, a case in each dispatcher it has, and
// its handlers in the chains of the events it hooks. The README walks through it.

type $ = EngineInterface

/** Every mod the hub hosts, in the order the ⋯ menu and the settings list them. */
export const MODS: Mod[] = [cacheTax, crew]

/** Adds each mod's hooks that have a matcher of their own: its commands, its pane. */
export function registerMods(on: On) {
  registerCacheTax(on)
  registerCrew(on)
}

// ---------- what the hub asks of a mod, by id ----------

export async function viewOf($: $, id: string, e: BandInput): Promise<ModView | null> {
  if (id === 'cache-tax') return cacheTaxView($, e)
  if (id === 'crew') return crewView($, e)
  return null
}

export async function badgeOf($: $, id: string, e: BandInput): Promise<Badge | null> {
  if (id === 'cache-tax') return cacheTaxBadge($, e)
  if (id === 'crew') return crewBadge($, e)
  return null
}

export async function openPaneOf($: $, id: string) {
  if (id === 'cache-tax') return cacheTaxOpenPane($)
  if (id === 'crew') return crewOpenPane($)
}

/** Runs when the person turns a mod on or off: timers armed or cancelled, status lines set or cleared. */
export async function switchedOf($: $, id: string, isOn: boolean) {
  if (id === 'cache-tax') return isOn ? cacheTaxEnable($) : cacheTaxDisable($)
  if (id === 'crew') return isOn ? undefined : crewDisable($)
}

// ---------- the events more than one mod hooks ----------
//
// A plugin hooks each event once without a matcher, so the hub hooks it and
// these chain the mods' handlers: each handler's `next` is the next mod's, the
// last one's what lies beneath the hub.

/** `next`, called at most once: a second call gets the first call's answer. */
function once<A, R>(f: (a: A) => R): (a: A) => R {
  let made: { value: R } | undefined
  return a => (made ??= { value: f(a) }).value
}

export async function onSessionStart($: $, e: ArgOf<'session.start'>, next: NextOf<'session.start'>) {
  return cacheTaxSessionStart($, e, next)
}

export async function onSessionAttach($: $, e: ArgOf<'session.attach'>, next: NextOf<'session.attach'>) {
  return cacheTaxSessionAttach($, e, next)
}

export async function onSessionEnd($: $, e: ArgOf<'session.end'>, next: NextOf<'session.end'>) {
  return cacheTaxSessionEnd($, e, next)
}

export async function onClassicSessionStart($: $, e: ArgOf<'classic.SessionStart'>, next: NextOf<'classic.SessionStart'>) {
  return cacheTaxClassicSessionStart($, e, next)
}

export async function onSessionCompact($: $, e: ArgOf<'session.compact'>, next: NextOf<'session.compact'>) {
  return cacheTaxSessionCompact($, e, next)
}

export async function onUiClose($: $, e: ArgOf<'ui.close'>, next: NextOf<'ui.close'>) {
  return cacheTaxUiClose($, e, next)
}

export async function onSessionMeasure($: $, e: ArgOf<'session.measure'>, next: NextOf<'session.measure'>) {
  return crewSessionMeasure($, e, next)
}

export async function onPromptCompose($: $, e: ArgOf<'prompt.compose'>, next: NextOf<'prompt.compose'>) {
  return crewPromptCompose($, e, next)
}

// Progress only watches: when its bookkeeping fails, the event goes on as if it weren't there.

export async function onSessionAppend($: $, e: ArgOf<'session.append'>, next: NextOf<'session.append'>) {
  const onward = once(next)
  try {
    return await crewSessionAppend($, e, onward)
  } catch {
    return onward(e)
  }
}

export async function onAgentSpawn($: $, e: ArgOf<'agent.spawn'>, next: NextOf<'agent.spawn'>) {
  const onward = once(next)
  try {
    return await crewAgentSpawn($, e, onward)
  } catch {
    return onward(e)
  }
}

export async function onPromptSubmit($: $, e: ArgOf<'prompt.submit'>, next: NextOf<'prompt.submit'>) {
  const onward = once(next)
  return cacheTaxPromptSubmit($, e, async e2 => {
    try {
      return await crewPromptSubmit($, e2, onward)
    } catch {
      return onward(e2)
    }
  })
}

export async function onTurnComplete($: $, e: ArgOf<'turn.complete'>, next: NextOf<'turn.complete'>) {
  return cacheTaxTurnComplete($, e, e2 => crewTurnComplete($, e2, next))
}

export async function* onTurnStep($: $, e: ArgOf<'turn.step'>, next: NextOf<'turn.step'>) {
  return yield* cacheTaxTurnStep($, e, e2 => crewTurnStep($, e2, next))
}
