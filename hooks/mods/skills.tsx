import { atom, read, update } from 'claude-code'
import type { Color, CommandInfo, EngineInterface, On, RenderInput } from 'claude-code'

import { hubColors, isModOn, offText, slotColor, type ArgOf, type BandInput, type Mod, type ModView, type NextOf, type Row } from '../hub'
import {
  AUTHORS, COUNCIL_OPTIONS, COUNCIL_SEATS, DEFAULT_FAVORITES, DEFAULT_MEMBERS, RECOMMENDED, SKILLS, STAGES,
  type AuthorId, type Skill,
} from './skills-catalog'

const ID = 'skills'
const NAME = 'Skills'
const PANE = 'skills'
const COMMAND = 'skill-deck'

const KEY_FAVORITES = 'skills:favorites'
const KEY_MEMBERS = 'skills:members'

const favorites = atom({ plugin: 'mods-hub', key: 'skillsFavorites' } as const, DEFAULT_FAVORITES)
const members = atom({ plugin: 'mods-hub', key: 'skillsMembers' } as const, DEFAULT_MEMBERS)
/** The favorite whose card the band shows. */
const focus = atom({ plugin: 'mods-hub', key: 'skillsFocus' } as const, '')
const panePick = atom({ plugin: 'mods-hub', key: 'skillsPick' } as const, '')
const paneAuthor = atom({ plugin: 'mods-hub', key: 'skillsAuthor' } as const, 'all' as PaneFilter)
const installState = atom({ plugin: 'mods-hub', key: 'skillsInstall' } as const, { phase: 'idle', note: '' } as InstallState)

type $ = EngineInterface
type PaneInput = RenderInput<'Pane'>

type PaneFilter = AuthorId | 'all' | 'existing'
type InstallState = { phase: 'idle' | 'running' | 'done' | 'failed'; note: string }
/** A skill you already had that the catalog has no card for. All we know is what it says about itself. */
type Existing = { id: string; name: string; line: string; command: string; group: string; fire?: undefined }
type Card = Skill | Existing

const OWN_GROUP = 'Your own skills'
const INSTALL_ORDER: AuthorId[] = ['matt', 'theo', 'poteto']
const INSTALL_TIMEOUT = 5 * 60 * 1000

const byId = (id: string): Skill | undefined => SKILLS.find(s => s.id === id)
const isExisting = (card: Card): card is Existing => 'command' in card
const strings = (value: unknown): string[] | undefined =>
  Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string') : undefined

// What the launcher last put in the box, so a second press replaces it and keeps only what you typed.
let lastFill = ''

/**
 * The command a skill runs under, or undefined when it isn't installed. A plugin's
 * skill is namespaced; its own name is tried first so Matt's code-review can't be
 * mistaken for the built-in one of the same name.
 */
export function commandFor(skill: Card, commands: CommandInfo[]): string | undefined {
  if (isExisting(skill)) return commands.some(c => c.name === skill.command) ? skill.command : undefined
  const plugin = AUTHORS[skill.author].plugin
  const names = new Set(commands.map(c => c.name))
  if (plugin && names.has(`${plugin}:${skill.id}`)) return `${plugin}:${skill.id}`
  if (commands.some(c => c.name === skill.id && c.source !== 'builtin')) return skill.id
  return commands.find(c => c.source !== 'builtin' && c.name.endsWith(`:${skill.id}`))?.name
}

/** "gsd:add-phase" reads Add Phase, under gsd. */
function toExisting(command: CommandInfo): Existing {
  const colon = command.name.indexOf(':')
  const short = colon < 0 ? command.name : command.name.slice(colon + 1)
  return {
    id: command.name,
    name: short.split(/[-_]/).filter(Boolean).map(word => word[0]!.toUpperCase() + word.slice(1)).join(' '),
    line: command.description.replace(/\s+/g, ' ').trim(),
    command: command.name,
    group: colon < 0 ? (command.plugin ?? OWN_GROUP) : command.name.slice(0, colon),
  }
}

/** Skills you have beyond the catalog: not the app's own, nor an MCP server's, nor this hub's commands. */
export function existingSkills(commands: CommandInfo[], self: string): Existing[] {
  const carded = new Set(SKILLS.flatMap(skill => commandFor(skill, commands) ?? []))
  return commands
    .filter(c => (c.source === 'user' || c.source === 'plugin') && c.plugin !== self && !carded.has(c.name))
    .map(toExisting)
}

/** A favorite is a catalog skill, or one you already had, for as long as you still have it. */
function cardFor(id: string, commands: CommandInfo[], self: string): Card | undefined {
  const skill = byId(id)
  if (skill) return skill
  const command = commands.find(c => c.name === id && c.plugin !== self && (c.source === 'user' || c.source === 'plugin'))
  return command ? toExisting(command) : undefined
}

/** The recommended skills not here yet. A plugin that's already in counts whole: its version is its own business. */
export function missingRecommended(commands: CommandInfo[]): Skill[] {
  return RECOMMENDED.filter(skill => {
    const plugin = AUTHORS[skill.author].plugin
    if (plugin && commands.some(c => c.name.startsWith(`${plugin}:`))) return false
    return !commandFor(skill, commands)
  })
}

/** What the install script is asked to do for one author. */
export function installArgs(id: AuthorId, missing: Skill[]): { argv: string[]; onDemand: string } {
  const author = AUTHORS[id]
  const ofAuthor = missing.filter(skill => skill.author === id)
  const onDemand = ofAuthor.filter(skill => skill.onDemand).map(skill => skill.id).join(' ')
  if (author.path) {
    const names = [...ofAuthor.map(skill => skill.id), ...(author.support ?? [])]
    return { argv: ['copy', author.repo, author.commit, author.path, ...names], onDemand }
  }
  return { argv: ['plugin', author.repo, author.commit, author.marketplace!, author.plugin!], onDemand }
}

/** How someone gets a skill they don't have. */
const missingHint = (skill: Skill): string =>
  skill.extra ? `Not part of the recommended set. ${AUTHORS[skill.author].install}` : 'Press Install Recommended Skills.'

/** What to do about a failed install, from the install script's exit code. */
export function installAdvice(exitCode: number): string {
  if (exitCode === 3) return 'They need Claude Code\'s command line: install it, then try again.'
  if (exitCode === 4) return 'The download failed: check your connection and try again.'
  return 'Try again, or follow the author\'s own steps under Thanks in the README.'
}
// The engine rejects both when the script can't start and when it times out, and doesn't say which.
const CANNOT_FINISH = 'The installer couldn\'t start or ran out of time, so try again. On Windows, follow the author\'s own steps under Thanks in the README.'

/** Council reads its members from what you ask, so they travel in the prompt. */
export function councilArgs(chosen: string[]): string {
  const providers = new Set(COUNCIL_OPTIONS.filter(o => chosen.includes(o.name)).map(o => o.provider))
  const shared = providers.size < chosen.length ? ', even though some share a provider' : ''
  return `Use these council members${shared}: ${chosen.join(', ')}.`
}

// ---------- actions ----------

async function installRecommended($: $) {
  if ((await read($, installState)).phase === 'running') return
  const missing = missingRecommended(await $.command.list())
  const failed: string[] = []
  const advice = new Set<string>()
  let addedPlugin = false
  for (const id of INSTALL_ORDER) {
    if (!missing.some(skill => skill.author === id)) continue
    const author = AUTHORS[id]
    await update($, installState, () => ({ phase: 'running', note: `Installing ${author.name}'s skills…` } as InstallState))
    const { argv, onDemand } = installArgs(id, missing)
    try {
      const result = await $.process.run(['sh', `${$.plugin.root}/hooks/install-skills.sh`, ...argv], {
        timeoutMs: INSTALL_TIMEOUT,
        env: { ON_DEMAND: onDemand },
      })
      if (result.exitCode !== 0) {
        failed.push(author.name)
        advice.add(installAdvice(result.exitCode))
      } else if (author.plugin) addedPlugin = true
    } catch {
      failed.push(author.name)
      advice.add(CANNOT_FINISH)
    }
  }
  // A new plugin needs a reload to show. Skills in the folder turn up by themselves.
  if (addedPlugin) {
    try {
      await $.command.run({ command: 'reload-plugins' })
    } catch {
      // Where the app won't run it, the next session picks the plugin up.
    }
  }
  if (failed.length > 0) {
    const note = `Couldn't install ${failed.join(' and ')}'s skills. ${[...advice].join(' ')}`
    await update($, installState, () => ({ phase: 'failed', note } as InstallState))
    $.ui.toast(note)
  } else {
    const note = missingRecommended(await $.command.list()).length > 0
      ? 'Installed. Start a new session to use them.'
      : 'Installed and ready.'
    await update($, installState, () => ({ phase: 'done', note } as InstallState))
    $.ui.toast(`Recommended skills: ${note.toLowerCase()}`)
  }
  $.ui.invalidate('ui.render')
}

async function runSkill($: $, id: string) {
  const commands = await $.command.list()
  const skill = cardFor(id, commands, $.plugin.name)
  if (!skill) return
  const command = commandFor(skill, commands)
  if (!command) {
    if (!isExisting(skill)) $.ui.toast(`${skill.name} isn't installed. ${missingHint(skill)}`)
    return
  }
  let args = ''
  if (id === 'council') {
    const chosen = await read($, members)
    if (chosen.length !== COUNCIL_SEATS) {
      $.ui.toast(`Council seats ${COUNCIL_SEATS} members: pick ${COUNCIL_SEATS} first`)
      return
    }
    args = councilArgs(chosen)
  }
  if (skill.fire) {
    try {
      await $.command.run({ command, ...(args ? { args } : {}) })
    } catch (err) {
      $.ui.toast(`${skill.name} couldn't start: ${err instanceof Error ? err.message : String(err)}`)
    }
    return
  }
  const box = await $.prompt.read()
  const typed = (lastFill && box.text.startsWith(lastFill) ? box.text.slice(lastFill.length) : box.text).trim()
  const start = args ? `/${command} ${args} ` : `/${command} `
  const text = start + typed
  const filled = await $.prompt.fill({ text, cursor: text.length })
  if (!filled.isFilled) {
    $.ui.toast(`Couldn't reach the prompt box${filled.refusal === 'dialog' ? ': close the open dialog first' : ''}`)
    return
  }
  lastFill = start
  $.ui.toast(`${skill.name} is in your prompt box: add any context and send`)
}

async function toggleFavorite($: $, id: string) {
  const list = await read($, favorites)
  const next = list.includes(id) ? list.filter(x => x !== id) : [...list, id]
  await update($, favorites, () => next)
  await $.store.set(KEY_FAVORITES, next)
}

async function toggleMember($: $, name: string) {
  const list = await read($, members)
  if (!list.includes(name) && list.length >= COUNCIL_SEATS) {
    $.ui.toast(`Council seats ${COUNCIL_SEATS}: untick one first`)
    return
  }
  const next = list.includes(name) ? list.filter(x => x !== name) : [...list, name]
  await update($, members, () => next)
  await $.store.set(KEY_MEMBERS, next)
}

async function setFocus($: $, id: string) {
  await update($, focus, () => id)
}

async function pick($: $, id: string) {
  await update($, panePick, current => (current === id ? '' : id))
}

async function setAuthor($: $, author: PaneFilter) {
  await update($, paneAuthor, () => author)
}

async function openPane($: $) {
  await $.ui.open({ id: PANE, title: 'All Skills' })
  $.ui.invalidate('ui.render')
}

// ---------- drawing ----------

/**
 * The card's body, shared by the band and the panel: when, how, what it needs, and Council's members.
 * At most four rows, so the band's chips and card fit its five without scrolling: a warning takes
 * the Needs row rather than adding one.
 */
async function cardRows($: $, e: BandInput | PaneInput, skill: Card, commands: CommandInfo[], accent?: Color): Promise<Row[]> {
  const { Box, Text, Button } = $.ui.resolve(e)
  const C = hubColors()
  const WARNING = '#E8590C'
  const line = (label: string, text: string, labelColor: Color | undefined = accent ?? C.text) => (
    <Text color={C.muted} dimColor={!C.muted}>
      <Text color={labelColor} weight="medium">{`${label}  `}</Text>
      {text}
    </Text>
  )
  // All it can say is its own description, cut to fit the band, which some write pages of.
  if (isExisting(skill)) {
    const about = skill.line.length > 240 ? `${skill.line.slice(0, 239)}…` : skill.line
    return [line('What', about || 'It has no description.'), line('From', skill.group)]
  }
  const chosen = await read($, members)
  const outside = skill.id === 'council'
    ? chosen.filter(name => COUNCIL_OPTIONS.find(o => o.name === name)?.provider !== 'anthropic')
    : []
  const rows: Row[] = [line('When', skill.when), line('How', skill.how)]
  if (!commandFor(skill, commands)) rows.push(line('Not installed', missingHint(skill), WARNING))
  else if (outside.length > 0) rows.push(line('Heads up', `${outside.join(' and ')} need${outside.length === 1 ? 's' : ''} a tool Claude Code can reach. Council reports it if not.`, WARNING))
  else if (skill.needs) rows.push(line('Needs', skill.needs))
  if (skill.id === 'council') {
    rows.push(
      <Box flexDirection="row" flexWrap="wrap" alignItems="center" gap="sm">
        <Text color={accent ?? C.text} weight="medium">{`Members ${chosen.length}/${COUNCIL_SEATS}`}</Text>
        {COUNCIL_OPTIONS.map(option => {
          const isChosen = chosen.includes(option.name)
          return (
            <Button
              key={`skills-member-${option.name}`}
              label={`${isChosen ? '☑' : '☐'} ${option.name}`}
              plain
              dimColor={!isChosen}
              onPress={() => void toggleMember($, option.name)}
            />
          )
        })}
      </Box>,
    )
  }
  return rows
}

/**
 * The favorites as chips: the picked one is the app's grey Button, as the selected tab is, with its name
 * in the slot's color. The app won't recolor the Button's fill, and a filled Box of our own is too tall.
 */
function focusChips($: $, e: BandInput, list: Card[], current: Card): Row {
  const { Box, Text, Button } = $.ui.resolve(e)
  const C = hubColors()
  return (
    <Box flexDirection="row" flexWrap="wrap" alignItems="center" gap="xs" marginTop="xs" marginBottom="xs">
      {list.map((skill, slot) => {
        const isPicked = skill.id === current.id
        const color = slotColor(slot)
        return (
          <Button
            key={`skills-chip-${skill.id}`}
            plain={isPicked ? undefined : true}
            variant={isPicked ? 'secondary' : undefined}
            dimColor={!isPicked}
            onPress={() => void setFocus($, skill.id)}
          >
            <Text color={isPicked ? color : C.muted} bold={isPicked && e.surface !== 'desktop'}>{skill.name}</Text>
          </Button>
        )
      })}
    </Box>
  )
}

/**
 * One skill as a row of the library. The whole row is one plain Button that runs it, because the app
 * draws grey Buttons taller than a row of text and they overlap when stacked. ⓘ opens the card.
 */
function skillRow($: $, e: PaneInput, skill: Card, isInstalled: boolean, isStarred: boolean): Row {
  const { Box, Text, Button } = $.ui.resolve(e)
  const C = hubColors()
  return (
    <Box key={`skills-row-${skill.id}`} flexDirection="row" justifyContent="space-between" alignItems="center" gap="sm" hover={{ backgroundColor: C.track }}>
      <Box flexGrow={1} flexShrink={1}>
        <Button key={`skills-run-${skill.id}`} plain onPress={() => void runSkill($, skill.id)}>
          <Text wrap="truncate">
            <Text color={isInstalled ? C.text : C.muted}>{`▶ ${skill.name}`}</Text>
            <Text color={C.muted} dimColor={!C.muted}>{`   ${isInstalled ? skill.line : `not installed · ${skill.line}`}`}</Text>
          </Text>
        </Button>
      </Box>
      <Box flexDirection="row" alignItems="center" gap="sm" flexShrink={0}>
        <Button key={`skills-star-${skill.id}`} label={isStarred ? '★' : '☆'} plain onPress={() => void toggleFavorite($, skill.id)} />
        <Button key={`skills-open-${skill.id}`} label="ⓘ" plain dimColor onPress={() => void pick($, skill.id)} />
      </Box>
    </Box>
  )
}

/** The install button, or word of it while it runs. Nothing to show once everything's here. */
function installButton($: $, e: BandInput | PaneInput, key: string, state: InstallState, missing: number): Row | undefined {
  const { Text, Button } = $.ui.resolve(e)
  const C = hubColors()
  if (state.phase === 'running') return <Text key={key} color={C.muted} dimColor={!C.muted}>Installing…</Text>
  if (missing === 0 || state.phase === 'done') return undefined
  return (
    <Button
      key={key}
      label="Install Recommended Skills"
      hotkey={e.surface === 'terminal' ? 'i' : undefined}
      variant="primary"
      onPress={() => void installRecommended($)}
    />
  )
}

// ---------- the mod ----------

export const skills: Mod = {
  id: ID,
  name: NAME,
  icon: '✦',
  pane: { id: PANE, label: 'All Skills' },
  description: 'Your favorite skills one press away, and a library of when and how to use the rest.',
}

// The favorites as chips, and the picked one's card: when, how, what it needs, with one Run in the header.
export async function skillsView($: EngineInterface, e: BandInput): Promise<ModView> {
  const { Text, Button } = $.ui.resolve(e)
  const C = hubColors()
  const commands = await $.command.list()
  const list = (await read($, favorites)).flatMap(id => cardFor(id, commands, $.plugin.name) ?? [])
  const state = await read($, installState)
  const missing = missingRecommended(commands).length
  const summary = state.note
    || (missing > 0
      ? `${RECOMMENDED.length - missing} of ${RECOMMENDED.length} recommended installed`
      : `${list.length} favorite${list.length === 1 ? '' : 's'}`)
  const headline = (
    <Text wrap="truncate">
      <Text color={C.text}>✦ Skills</Text>
      <Text color={C.muted} dimColor={!C.muted}>{` · ${summary}`}</Text>
    </Text>
  )
  const install = installButton($, e, 'skills-install', state, missing)
  if (list.length === 0) {
    return {
      headline,
      ...(install ? { actions: [install] } : {}),
      rows: [<Text color={C.muted} dimColor={!C.muted}>No favorites yet. Open All Skills and ★ the ones you reach for most.</Text>],
    }
  }
  const focused = await read($, focus)
  const slot = Math.max(0, list.findIndex(s => s.id === focused))
  const current = list[slot]!
  const run = <Button key="skills-focus-run" label={`Run ${current.name}`} variant={install ? 'secondary' : 'primary'} onPress={() => void runSkill($, current.id)} />
  // Run can't do anything for a skill that isn't here, so the one button asks for what can.
  const actions = !commandFor(current, commands) && install ? [install] : install ? [install, run] : [run]
  return {
    headline,
    actions,
    rows: [focusChips($, e, list, current), ...(await cardRows($, e, current, commands, slotColor(slot)))],
  }
}

export async function skillsOpenPane($: EngineInterface): Promise<void> {
  await openPane($)
}

export function registerSkills(on: On) {
  on('command.run', { command: COMMAND }, async $ => {
    if (!isModOn(ID)) return { text: offText(NAME) }
    await openPane($)
    return { text: 'The skills library is open.' }
  })

  // The library: every skill by when you'd use it, opening into its card in place.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const C = hubColors()
    if (!isModOn(ID)) return <Text dimColor>{offText(NAME)}</Text>
    const commands = await $.command.list()
    const stars = await read($, favorites)
    const picked = await read($, panePick)
    const author = await read($, paneAuthor)
    const filter = (id: PaneFilter, label: string) => (
      <Button key={`skills-author-${id}`} label={label} variant={author === id ? 'primary' : 'secondary'} onPress={() => void setAuthor($, id)} />
    )
    const existing = existingSkills(commands, $.plugin.name)
    const openCard = async (skill: Card, caption: string): Promise<Row> => (
      <Box flexDirection="column" gap="xs" paddingX="sm" paddingY="xs" borderStyle="round" borderDimColor>
        <Text color={C.muted} dimColor={!C.muted}>{caption}</Text>
        {await cardRows($, e, skill, commands)}
      </Box>
    )
    const stages: Row[] = []
    for (const group of author === 'existing' ? [...new Set(existing.map(s => s.group))].sort() : []) {
      const rows: Row[] = []
      for (const skill of existing.filter(s => s.group === group)) {
        rows.push(skillRow($, e, skill, true, stars.includes(skill.id)))
        if (picked === skill.id) rows.push(await openCard(skill, 'Run puts it in your prompt box'))
      }
      stages.push(
        <Box flexDirection="column" gap="xs">
          <Text weight="semibold" bold color={C.text}>{group}</Text>
          {rows}
        </Box>,
      )
    }
    for (const stage of author === 'existing' ? [] : STAGES) {
      const shown = SKILLS.filter(s => s.stage === stage.id && (author === 'all' || s.author === author))
      if (shown.length === 0) continue
      const rows: Row[] = []
      for (const skill of shown) {
        rows.push(skillRow($, e, skill, Boolean(commandFor(skill, commands)), stars.includes(skill.id)))
        if (picked === skill.id) {
          rows.push(await openCard(skill, `By ${AUTHORS[skill.author].credit}${skill.fire ? ' · Run starts it right away' : ' · Run puts it in your prompt box'}`))
        }
      }
      stages.push(
        <Box flexDirection="column" gap="xs">
          <Text>
            <Text weight="semibold" bold color={C.text}>{stage.name}</Text>
            <Text color={C.muted} dimColor={!C.muted}>{` · ${stage.hint}`}</Text>
          </Text>
          {rows}
        </Box>,
      )
    }
    const state = await read($, installState)
    const install = installButton($, e, 'skills-install-pane', state, missingRecommended(commands).length)
    return (
      <Box flexDirection="column" gap="sm">
        {state.note || install ? (
          <Box flexDirection="row" flexWrap="wrap" alignItems="center" gap="sm">
            {install}
            {state.phase !== 'running' && state.note ? <Text color={C.muted} dimColor={!C.muted}>{state.note}</Text> : undefined}
          </Box>
        ) : undefined}
        <Box flexDirection="row" flexWrap="wrap" alignItems="center" gap="sm">
          {filter('all', 'All')}
          {filter('theo', AUTHORS.theo.name)}
          {filter('poteto', AUTHORS.poteto.name)}
          {filter('matt', AUTHORS.matt.name)}
          {filter('existing', `Existing ${existing.length}`)}
        </Box>
        {author === 'existing' && existing.length === 0
          ? <Text color={C.muted} dimColor={!C.muted}>No other skills yet. Anything you add to ~/.claude/skills, or get from a plugin, shows up here.</Text>
          : stages}
      </Box>
    )
  })
}

// ---------- this mod's part of the events every mod shares (hooks/mods/index.ts chains them) ----------

export async function skillsSessionStart($: EngineInterface, e: ArgOf<'session.start'>, next: NextOf<'session.start'>) {
  const memberNames = COUNCIL_OPTIONS.map(o => o.name)
  const storedStars = strings(await $.store.get(KEY_FAVORITES))
  const storedMembers = strings(await $.store.get(KEY_MEMBERS))
  await update($, favorites, () => storedStars ?? DEFAULT_FAVORITES)
  await update($, members, () => storedMembers?.filter(name => memberNames.includes(name)) ?? DEFAULT_MEMBERS)
  const result = await next(e)
  await $.command.register({
    name: COMMAND,
    description: 'Open the skills library: when and how to use each skill, and ★ your favorites (mods-hub)',
    immediate: true,
  })
  return result
}
