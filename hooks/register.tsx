import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { HubView } from '../types'
import { hubColors, isModOn, setLook, setSwitches, type BandInput, type Badge, type Mod, type ModView } from './hub'
import {
  MODS, badgeOf, onAgentSpawn, onClassicSessionStart, onPromptCompose, onPromptSubmit, onSessionAppend, onSessionAttach,
  onSessionCompact, onSessionEnd, onSessionMeasure, onSessionStart, onTurnComplete, onTurnStep, onUiClose, closePaneOf, openPaneOf,
  registerMods, switchedOf, viewOf,
} from './mods'

/** Favorites get a tab each; every other mod is one press away under ⋯. */
export const MAX_FAVORITES = 4
/** A mod's rows under its headline: the hub shows this many at most, and scrolls the rest. */
export const BODY_ROWS = 5
/** The longest tab label in columns; a longer name ends in "…". */
const TAB_COLUMNS = 14

const KEY_ENABLED = 'hub:enabled'
const KEY_FAVORITES = 'hub:favorites'
const KEY_KNOWN = 'hub:known'
const KEY_SELECTED = 'hub:selected'
const KEY_FOLDED = 'hub:folded'

const view = atom({ plugin: 'mods-hub', key: 'view' } as const, 'tabs' as HubView)
const selected = atom({ plugin: 'mods-hub', key: 'selected' } as const, '')
const favorites = atom({ plugin: 'mods-hub', key: 'favorites' } as const, [] as string[])
const enabled = atom({ plugin: 'mods-hub', key: 'enabled' } as const, {} as Record<string, boolean>)
const folded = atom({ plugin: 'mods-hub', key: 'folded' } as const, false)
const offset = atom({ plugin: 'mods-hub', key: 'offset' } as const, 0)

type $ = EngineInterface

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n))
const byId = (id: string): Mod | undefined => MODS.find(m => m.id === id)

// The body as last drawn, for the scroll hook.
let drawnRows = 0
let drawnBody = BODY_ROWS

/** Loads the switches and favorites; a mod the hub hasn't seen before is on, and starred while there's room. */
async function load($: $) {
  const theme = (await $.config.list()).find(row => row.key === 'theme')?.value
  setLook({ light: typeof theme === 'string' && theme.startsWith('light'), noColor: Boolean(await $.env.get('NO_COLOR')) })
  const ids = MODS.map(m => m.id)
  const stored = await $.store.get(KEY_ENABLED)
  const saved = stored && typeof stored === 'object' ? (stored as Record<string, unknown>) : {}
  const loaded = Object.fromEntries(ids.map(id => [id, saved[id] !== false]))
  setSwitches(loaded)

  const storedFavorites = await $.store.get(KEY_FAVORITES)
  const storedKnown = await $.store.get(KEY_KNOWN)
  const known = Array.isArray(storedKnown) ? storedKnown.filter((x): x is string => typeof x === 'string') : []
  let stars = Array.isArray(storedFavorites)
    ? storedFavorites.filter((x): x is string => typeof x === 'string' && ids.includes(x))
    : ids.slice(0, MAX_FAVORITES)
  for (const id of ids) if (!known.includes(id) && !stars.includes(id) && stars.length < MAX_FAVORITES) stars.push(id)
  stars = stars.slice(0, MAX_FAVORITES)
  await $.store.set(KEY_KNOWN, ids)
  await $.store.set(KEY_FAVORITES, stars)

  const storedSelected = await $.store.get(KEY_SELECTED)
  const pick = typeof storedSelected === 'string' && ids.includes(storedSelected) ? storedSelected : (stars[0] ?? ids[0] ?? '')
  const storedFold = await $.store.get(KEY_FOLDED)

  await update($, enabled, () => loaded)
  await update($, favorites, () => stars)
  await update($, selected, () => pick)
  await update($, folded, () => storedFold === true)
  await update($, view, () => 'tabs')
  await update($, offset, () => 0)
}

/** A tab or a ⋯ pick: shows that mod's view, unfolded. */
async function select($: $, id: string) {
  await update($, selected, () => id)
  await update($, view, () => 'tabs')
  await update($, offset, () => 0)
  await update($, folded, () => false)
  await $.store.set(KEY_SELECTED, id)
  await $.store.set(KEY_FOLDED, false)
}

/** ⋯ and ⚙: a second press goes back to the selected tab. */
async function toggleView($: $, next: HubView) {
  await update($, view, v => (v === next ? 'tabs' : next))
  await update($, offset, () => 0)
  await update($, folded, () => false)
  await $.store.set(KEY_FOLDED, false)
}

async function showSettings($: $) {
  await update($, view, () => 'settings')
  await update($, offset, () => 0)
  await update($, folded, () => false)
  await $.store.set(KEY_FOLDED, false)
}

async function toggleFold($: $) {
  const next = !(await read($, folded))
  await update($, folded, () => next)
  await $.store.set(KEY_FOLDED, next)
}

async function scrollBody($: $, by: number) {
  if (drawnRows > drawnBody) await update($, offset, o => clamp(o + by, 0, drawnRows - drawnBody))
}

async function setEnabled($: $, id: string, isOn: boolean) {
  const mod = byId(id)
  if (!mod || isModOn(id) === isOn) return
  const next = { ...Object.fromEntries(MODS.map(m => [m.id, isModOn(m.id)])), [id]: isOn }
  setSwitches(next)
  await update($, enabled, () => next)
  await $.store.set(KEY_ENABLED, next)
  try {
    await switchedOf($, id, isOn)
  } catch (err) {
    $.ui.log(`${mod.name}: turning ${isOn ? 'on' : 'off'} failed, ${err instanceof Error ? err.message : String(err)}`)
  }
  $.ui.toast(isOn ? `${mod.name} is on` : `${mod.name} is off: nothing it does runs until you turn it back on`)
  $.ui.invalidate('ui.render')
}

async function toggleFavorite($: $, id: string) {
  const stars = await read($, favorites)
  if (!stars.includes(id) && stars.length >= MAX_FAVORITES) {
    $.ui.toast(`Up to ${MAX_FAVORITES} favorites: unstar one first`)
    return
  }
  const next = stars.includes(id) ? stars.filter(x => x !== id) : [...stars, id]
  await update($, favorites, () => next)
  await $.store.set(KEY_FAVORITES, next)
}

/** Whether a mod's pane is up, by the engine's own record, so a reload or the pane's own close mark can't leave it stale. */
async function isPaneUp($: $, mod: Mod): Promise<boolean> {
  return (await $.ui.panes()).some(pane => pane.id === mod.pane?.id && pane.isPlaced)
}

/** The hub's panel button: opens the mod's pane, or closes it while it's up. */
async function togglePane($: $, mod: Mod) {
  if (await isPaneUp($, mod)) await closePaneOf($, mod.id)
  else await openPaneOf($, mod.id)
  $.ui.invalidate('ui.render')
}

/** Each enabled mod's mark, for the tabs and the ⋯ list. A mod that fails to make one still gets its tab. */
async function badgesOf($: $, e: BandInput): Promise<Map<string, Badge>> {
  const badges = new Map<string, Badge>()
  for (const mod of MODS) {
    if (!isModOn(mod.id)) continue
    try {
      const badge = await badgeOf($, mod.id, e)
      if (badge) badges.set(mod.id, badge)
    } catch {
      // A mark is a nicety.
    }
  }
  return badges
}

export const register: Register = on => {
  // The hub's switches load before any mod's start runs, so a mod that's off never arms.
  on('session.start', async ($, e, next) => {
    await load($)
    const r = await onSessionStart($, e, next)
    await $.command.register({
      name: 'mods',
      description: 'Open the mods hub settings: turn mods on and off, and star up to 4 as tabs (mods-hub)',
      immediate: true,
    })
    return r
  })
  on('session.attach', ($, e, next) => onSessionAttach($, e, next))
  on('session.end', ($, e, next) => onSessionEnd($, e, next))
  on('classic.SessionStart', ($, e, next) => onClassicSessionStart($, e, next))
  on('session.compact', ($, e, next) => onSessionCompact($, e, next))
  on('session.measure', ($, e, next) => onSessionMeasure($, e, next))
  on('session.append', ($, e, next) => onSessionAppend($, e, next)).catch(($, e, next) => next(e))
  on('prompt.compose', ($, e, next) => onPromptCompose($, e, next))
  on('prompt.submit', ($, e, next) => onPromptSubmit($, e, next)).catch(($, e, next) => next(e))
  on('agent.spawn', ($, e, next) => onAgentSpawn($, e, next)).catch(($, e, next) => next(e))
  on('turn.complete', ($, e, next) => onTurnComplete($, e, next))
  // However a pane closes, the panel button goes back to its opening words.
  on('ui.close', async ($, e, next) => {
    const closed = await onUiClose($, e, next)
    $.ui.invalidate('ui.render')
    return closed
  })
  on('turn.step', async function* ($, e, next) {
    return yield* onTurnStep($, e, next)
  })

  registerMods(on)

  on('command.run', { command: 'mods' }, async $ => {
    await showSettings($)
    return { text: 'mods hub settings are open above the prompt' }
  })

  // The person scrolls the body; the tab row stays put.
  on('ui.scroll', { component: 'AbovePrompt' }, async ($, e, next) => {
    await scrollBody($, e.by)
    return next(e)
  })

  // The hub, as in the Mods Hub design: the selected mod on top (its headline and
  // actions, then its rows), and a darker bar along the bottom with a tab per
  // favorite on the left and More ⋯, ⚙ and collapse on the right.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const rest = await next(e)
    if (e.props.hasSurvey) return rest
    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    const isDesktop = e.surface === 'desktop'
    const C = hubColors()
    const muted = (text: string) => <Text color={C.muted} dimColor={!C.muted} wrap="truncate">{text}</Text>
    const showing = await read($, view)
    const stars = (await read($, favorites)).filter(id => byId(id))
    const switches = await read($, enabled)
    const isFolded = await read($, folded)
    const at = await read($, offset)
    const isOn = (id: string) => switches[id] !== false
    const current = byId(await read($, selected)) ?? byId(stars[0] ?? '') ?? MODS[0]

    const badges = await badgesOf($, e)

    const tab = (mod: Mod, hotkey?: string) => {
      const badge = badges.get(mod.id)
      const isSelected = showing === 'tabs' && mod.id === current?.id
      const name = mod.name.length > TAB_COLUMNS - 2 ? `${mod.name.slice(0, TAB_COLUMNS - 3)}…` : mod.name
      // On the desktop the selected tab is the app's own grey, rounded button, as Open Panel is: the app sizes
      // and centers it (about 28px, keeping the rounded tray near 54px). The others, and every tab in the
      // terminal, are plain labels.
      return (
        <Box flexShrink={0}>
          <Button
            key={`hub-tab-${mod.id}`}
            hotkey={isDesktop ? undefined : hotkey}
            plain={isDesktop && isSelected ? undefined : true}
            variant={isDesktop && isSelected ? 'secondary' : undefined}
            dimColor={!isSelected}
            onPress={() => void select($, mod.id)}
          >
            <Text bold={isSelected && !isDesktop} underline={isSelected && !isDesktop} color={isSelected ? C.text : C.muted} dimColor={!isOn(mod.id)}>{name}</Text>
            {badge && mod.id !== current?.id ? <Text color={badge.color}>{` ${badge.glyph}`}</Text> : ''}
          </Button>
        </Box>
      )
    }

    // ----- what the top shows: a headline, its actions, and rows -----

    let shownView: ModView
    if (showing === 'settings') {
      shownView = {
        headline: (
          <Text wrap="truncate">
            <Text color={C.text}>Mods</Text>
            <Text color={C.muted} dimColor={!C.muted}>{` · ★ ${stars.length} of ${MAX_FAVORITES} favorites get a tab · a mod that's off stops completely`}</Text>
          </Text>
        ),
        actions: [<Button key="hub-done" label="Done" variant="secondary" onPress={() => void toggleView($, 'settings')} />],
        rows: MODS.map(mod => {
          const isModOn = isOn(mod.id)
          const starred = stars.includes(mod.id)
          return (
            <Box flexDirection="row" justifyContent="space-between" alignItems="center" gap={1}>
              <Box flexShrink={1}>
                <Text wrap="truncate">
                  <Text color={isModOn ? C.text : C.muted} dimColor={!isModOn && !C.muted}>{`${mod.icon} ${mod.name}`}</Text>
                  <Text color={C.muted} dimColor={!C.muted}>{` · ${mod.description}`}</Text>
                </Text>
              </Box>
              <Box flexDirection="row" gap="sm" flexShrink={0}>
                <Button key={`hub-on-${mod.id}`} label={isModOn ? '● On' : '○ Off'} variant={isModOn ? 'primary' : 'secondary'} onPress={() => void setEnabled($, mod.id, !isModOn)} />
                <Button key={`hub-fav-${mod.id}`} label={starred ? '★' : '☆'} variant="secondary" onPress={() => void toggleFavorite($, mod.id)} />
              </Box>
            </Box>
          )
        }),
      }
    } else if (showing === 'menu') {
      shownView = {
        headline: (
          <Text wrap="truncate">
            <Text color={C.text}>All mods</Text>
            <Text color={C.muted} dimColor={!C.muted}> · pick one to show it here</Text>
          </Text>
        ),
        rows: MODS.map(mod => {
          const isModOn = isOn(mod.id)
          const badge = badges.get(mod.id)
          return (
            <Box flexDirection="row" justifyContent="space-between" alignItems="center" gap={1}>
              <Box flexDirection="row" alignItems="center" gap={1} flexShrink={1}>
                <Box flexShrink={0}>
                  <Button key={`hub-menu-${mod.id}`} plain dimColor={!isModOn} onPress={() => void select($, mod.id)}>
                    {`${mod.icon} ${mod.name}${stars.includes(mod.id) ? ' ★' : ''}`}
                    {badge ? <Text color={badge.color}> {badge.glyph}</Text> : ''}
                  </Button>
                </Box>
                <Box flexShrink={1}>{muted(isModOn ? mod.description : 'off')}</Box>
              </Box>
              {!isModOn && (
                <Box flexShrink={0}>
                  <Button key={`hub-menu-on-${mod.id}`} label="Turn on" variant="secondary" onPress={() => void setEnabled($, mod.id, true)} />
                </Box>
              )}
            </Box>
          )
        }),
      }
    } else if (!current) {
      shownView = { headline: muted('No mods yet. Add one under hooks/mods/ in the mods-hub plugin.'), rows: [] }
    } else if (!isOn(current.id)) {
      shownView = {
        headline: muted(`${current.name} is off. Nothing it does runs until you turn it back on.`),
        actions: [<Button key={`hub-turnon-${current.id}`} label="Turn on" variant="secondary" onPress={() => void setEnabled($, current.id, true)} />],
        rows: [],
      }
    } else {
      let drawn: ModView | null
      try {
        drawn = await viewOf($, current.id, e)
      } catch (err) {
        drawn = { headline: muted(`${current.name} couldn't draw: ${err instanceof Error ? err.message : String(err)}`), rows: [] }
      }
      shownView = drawn ?? { headline: <Text color={C.text}>{`${current.icon} ${current.name}`}</Text>, rows: [] }
      // Mods with a side pane open and close it from here, before their own actions.
      if (current.pane) {
        const label = (await isPaneUp($, current)) ? 'Close Panel' : (current.pane.label ?? 'Open Panel')
        const panel = <Button key="hub-open" label={label} hotkey={isDesktop ? undefined : 'p'} variant="secondary" onPress={() => void togglePane($, current)} />
        shownView = { ...shownView, actions: [panel, ...(shownView.actions ?? [])] }
      }
    }

    // ----- the window over the rows -----

    const rows = shownView.rows
    // Two border rows, the headline, the scroll line and the bar leave the rest for rows.
    const body = clamp(Math.min(BODY_ROWS, e.props.maxRows - 5), 1, BODY_ROWS)
    const top = clamp(at, 0, Math.max(0, rows.length - body))
    const shown = isFolded ? [] : rows.slice(top, top + body)
    drawnRows = isFolded ? 0 : rows.length
    drawnBody = body
    const scrolls = !isFolded && rows.length > body

    const tempTab = current && !stars.includes(current.id) ? current : undefined

    const header = (
      <Box flexDirection="row" alignItems="center" justifyContent="space-between" gap={isDesktop ? 'md' : 1} marginBottom={isDesktop ? 'xs' : 0}>
        <Box flexShrink={1}>{shownView.headline}</Box>
        {shownView.actions && shownView.actions.length > 0 && (
          <Box flexDirection="row" alignItems="center" gap="sm" flexShrink={0}>{shownView.actions}</Box>
        )}
      </Box>
    )

    const scrollLine = scrolls && (
      <Box flexDirection="row" justifyContent="flex-end" alignItems="center" gap={1}>
        {muted(`${top + 1}–${top + shown.length} of ${rows.length}`)}
        <Button key="hub-up" label="↑" plain dimColor={top === 0} onPress={() => void scrollBody($, -1)} />
        <Button key="hub-down" label="↓" plain dimColor={top + body >= rows.length} onPress={() => void scrollBody($, 1)} />
      </Box>
    )

    // A darker, rounded tray for the tabs and controls inside the band's padding (the app keeps a mod's drawing
    // off the band's edges), a small step below the mod. Its rounded border is what rounds it, and pads it too.
    const bar = (
      <Box
        flexDirection="row"
        alignItems="center"
        justifyContent="space-between"
        gap={isDesktop ? 'md' : 1}
        paddingX={1}
        marginTop={isDesktop ? 'xs' : 0}
        backgroundColor={isDesktop ? C.bar : undefined}
        borderStyle={isDesktop && C.bar ? 'round' : undefined}
        borderColor={isDesktop ? C.bar : undefined}
      >
        <Box flexDirection="row" alignItems="center" gap={isDesktop ? 'xs' : 1} flexShrink={1} flexWrap="wrap">
          {stars.map((id, i) => tab(byId(id)!, String(i + 1)))}
          {tempTab && tab(tempTab)}
        </Box>
        <Box flexDirection="row" alignItems="center" gap={isDesktop ? 'md' : 1} flexShrink={0}>
          <Button key="hub-more" label="More ⋯" hotkey={isDesktop ? undefined : 'm'} plain dimColor={showing !== 'menu'} onPress={() => void toggleView($, 'menu')} />
          <Button key="hub-settings" label="⚙" hotkey={isDesktop ? undefined : 's'} plain dimColor={showing !== 'settings'} onPress={() => void toggleView($, 'settings')} />
          <Button key="hub-fold" label={isFolded ? '▸' : '▾'} hotkey={isDesktop ? undefined : 'f'} plain dimColor onPress={() => void toggleFold($)} />
        </Box>
      </Box>
    )

    // The desktop draws the band's rounded, darker frame itself: the hub adds only a hairline over the bar.
    // The terminal draws none, so there the hub keeps a dim rounded border of its own.
    const hub = (
      <Box flexDirection="column" borderStyle={isDesktop ? undefined : 'round'} borderDimColor={!isDesktop}>
        <Box flexDirection="column" paddingX={1} paddingTop={isDesktop ? 'xs' : 0} paddingBottom={isDesktop ? 'sm' : 0}>
          {header}
          {shown}
          {scrollLine}
        </Box>
        {!isDesktop && <Text dimColor wrap="truncate">{'─'.repeat(Math.max(1, e.props.bodyColumns))}</Text>}
        {bar}
      </Box>
    )
    return rest ? (
      <Box flexDirection="column">
        {rest}
        {hub}
      </Box>
    ) : (
      hub
    )
  })
}
