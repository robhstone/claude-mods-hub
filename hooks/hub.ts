import type { EventName, Hook, HookStream, RenderElement, RenderInput } from 'claude-code'

/** The band's render input, which every mod's view and badge draw from. */
export type BandInput = RenderInput<'AbovePrompt'>

/** One row of a mod's body: the hub shows as many as fit and scrolls the rest. */
export type Row = RenderElement

/** A hook's input for event `E`. */
export type ArgOf<E extends EventName> = Parameters<Hook<E>>[1]

/**
 * What a mod's handler for a shared event calls to go on: the next mod's handler,
 * or what lies beneath the hub. A streamed event's is a plain stream: read it with
 * `yield* next(e)`, which also returns its result.
 */
export type NextOf<E extends EventName> = (e: ArgOf<E>) => Plain<ReturnType<Parameters<Hook<E>>[2]>>

type Plain<R> = R extends HookStream<infer C, infer T> ? AsyncGenerator<C, T> : R

/**
 * What a mod draws in the hub: a headline (its state at a glance, kept when the
 * hub is collapsed), up to two action Buttons beside it, and its rows under
 * both, of which the hub shows 5 and scrolls the rest. The hub adds a button that
 * opens and closes the pane before the actions of a mod with one.
 */
export type ModView = { headline: Row; actions?: Row[]; rows: Row[] }

/** A small mark on a tab the person isn't looking at, so nothing has to switch tabs on its own. */
export type Badge = { glyph: string; color?: string; label: string }

// The person's switches, as the hub loaded them; read by hooks, which can't await.
let switches: Record<string, boolean> = {}

/**
 * Whether the person has a mod on. A mod that's off must change nothing:
 * every hook that acts starts with `if (!isModOn(ID)) return next(e)`.
 */
export const isModOn = (id: string) => switches[id] !== false

/** The hub's own: replaces the switches every mod reads. */
export function setSwitches(next: Record<string, boolean>) {
  switches = { ...next }
}

/**
 * A mod the hub hosts. The engine only lets `$` be handed to functions declared
 * at the top of a file, so a mod is this description plus top-level functions:
 * its view, badge, pane and switches, and its handlers for the events mods
 * share, which hooks/mods/index.ts dispatches to by id. See the README.
 */
export type Mod = {
  /** Stable id: store keys and button keys are made from it. Lowercase letters and dashes. */
  id: string
  /** The tab's label. */
  name: string
  /** One glyph before the name. */
  icon: string
  /** One line for the settings view. */
  description: string
  /**
   * Its side pane, if it has one: the id it opens under, and what the hub's button says while it's
   * closed (Open Panel unless given). While it's open the button says Close Panel and closes it.
   */
  pane?: { id: string; label?: string }
}

/** What a mod that's off answers for its own slash commands. */
export const offText = (name: string) => `${name} is off. Turn it on from the mods hub above the prompt (⚙, or /mods).`

// The person's theme, as the hub last read it, and whether NO_COLOR is set.
let look = { light: false, noColor: false }

export function setLook(next: Partial<typeof look>) {
  look = { ...look, ...next }
}

/** A color for each slot of a list, repeating after five; undefined under NO_COLOR. Picked to read on the band in either theme. */
export function slotColor(slot: number): string | undefined {
  if (look.noColor) return undefined
  const colors = look.light
    ? ['#C2410C', '#A16207', '#15803D', '#1D4ED8', '#7E22CE']
    : ['#FF8A65', '#F5C04E', '#6FCF97', '#6CB6FF', '#B794F6']
  return colors[slot % colors.length]
}

/**
 * The hub's colors, from the Mods Hub design: the app draws the band's own fill,
 * the hub a darker bar under the tabs. Every value is undefined under NO_COLOR.
 */
export function hubColors() {
  const c = look.light
    ? { bar: '#ebe9e3', line: '#dedbd2', text: '#1f1e1d', muted: '#6f6e69', track: '#e3e2dc' }
    : { bar: '#1f1f1f', line: '#2a2a2a', text: '#e7e9ee', muted: '#a1a1a1', track: '#3a3a37' }
  return look.noColor ? { bar: undefined, line: undefined, text: undefined, muted: undefined, track: undefined } : c
}
