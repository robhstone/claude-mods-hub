import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, TurnUsage } from 'claude-code'

import type { Agent, PlanItem, Run, Step, StepStatus, Usage } from '../../types'
import { hubColors, isModOn, type BandInput, type ArgOf, type Badge, type Mod, type ModView, type NextOf, type Row } from '../hub'

const PANE = 'crew'
const ID = 'crew'
const TITLE = 'Progress'

// Change a tag when that value's fields change: it declines what an earlier
// version stored, which outlives a reload.
const runs = atom({ plugin: 'mods-hub', key: 'crewRuns' } as const, [], { shape: 'runs-2' })
const plan = atom({ plugin: 'mods-hub', key: 'crewPlan' } as const, [], { shape: 'plan-1' })
const usage = atom({ plugin: 'mods-hub', key: 'crewUsage' } as const, {})
// Bumped once a second while an agent runs, so elapsed times keep moving.
const now = atom({ plugin: 'mods-hub', key: 'crewNow' } as const, 0)

const COLORS = ['#E8590C', '#D6336C', '#2F9E44', '#1C7ED6', '#7048E8', '#C92A2A', '#0C8599', '#E67700']
const ACCENT = '#E8590C'
const RUNNING = '#2F9E44'
const hue = (i: number) => COLORS[i % COLORS.length] ?? ACCENT
const FINISHED = '#E0A800'

const WHY_PROMPT = [
  'When you launch a sub-agent with the Agent tool, make the first line of its prompt',
  '`Why: <one plain-English sentence on why this agent type suits this task>`,',
  'for example `Why: Explore is fast at scanning many files without editing them.`',
  'Give it a `description` of a few plain words a non-engineer would understand.',
].join(' ')

type $ = EngineInterface

// ---------- helpers ----------

const WRAP_UP = [
  'The person watching this work says what you have is good enough.',
  'Stop exploring now: start no new searches, reads or edits.',
  'Write your final report from what you have already found and decided,',
  'and say briefly what you left unchecked.',
].join(' ')

// A reply's tokens split three ways: new work, cache re-reads, and a weight
// by what each kind costs (cache reads a tenth, writes a quarter more,
// output five times), which is how usage is shared out between steps.
const split = (u: TurnUsage | null | undefined) => {
  if (!u) return { tokens: 0, cached: 0, work: 0 }
  const read = u.cache_read_input_tokens ?? 0
  const wrote = u.cache_creation_input_tokens ?? 0
  return {
    tokens: u.input_tokens + wrote + u.output_tokens,
    cached: read,
    work: u.input_tokens + wrote * 1.25 + read * 0.1 + u.output_tokens * 5,
  }
}

const percent = (n: number) => (n < 0.1 ? '<0.1%' : n < 10 ? `${n.toFixed(1)}%` : `${Math.round(n)}%`)

const base = (path: unknown) => String(path ?? '').split('/').filter(Boolean).pop() ?? ''

const clip = (text: string, n: number) => (text.length > n ? `${text.slice(0, n - 1)}…` : text)

const duration = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

const tokens = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)

const modelName = (id: string) => {
  const m = /(opus|sonnet|haiku|fable)-(\d+)(?:-(\d+))?/i.exec(id)
  if (!m || !m[1] || !m[2]) return id
  const family = m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase()
  return `${family} ${m[2]}${m[3] && m[3].length <= 2 ? `.${m[3]}` : ''}`
}

// What a tool call is doing, in plain words.
const describe = (tool: string, input: Record<string, unknown>): string => {
  const s = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : '')
  switch (tool) {
    case 'Read':
      return `Reading ${base(input.file_path)}`
    case 'Write':
      return `Writing ${base(input.file_path)}`
    case 'Edit':
    case 'MultiEdit':
      return `Editing ${base(input.file_path)}`
    case 'Grep':
      return `Searching for “${clip(s('pattern'), 30)}”`
    case 'Glob':
      return `Finding files ${clip(s('pattern'), 30)}`
    case 'Bash':
      return clip(s('description') || `Running ${s('command')}`, 48)
    case 'WebSearch':
      return `Searching the web: ${clip(s('query'), 36)}`
    case 'WebFetch':
      try {
        return `Reading ${new URL(s('url')).host}`
      } catch {
        return 'Reading a web page'
      }
    case 'Agent':
      return `Delegating: ${clip(s('description'), 36)}`
    case 'TodoWrite':
    case 'TaskCreate':
    case 'TaskUpdate':
      return 'Updating its checklist'
    default:
      return tool.startsWith('mcp__') ? `Using ${tool.split('__').slice(1).join(' · ')}` : `Using ${tool}`
  }
}

const parseWhy = (prompt: string) => {
  const m = /^\s*why:\s*(.+)$/im.exec(prompt)
  const purpose = m?.[1]?.trim() ?? ''
  const brief = prompt
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !/^why:/i.test(l))[0]
  return { purpose, brief: clip(brief ?? '', 160) }
}

// ---------- state changes ----------

const currentRun = (list: Run[]) => list[list.length - 1]

async function startRun($: $, prompt: string) {
  const at = await $.clock.now()
  const u = await read($, usage)
  await update($, runs, list =>
    [
      ...list,
      {
        id: `run-${at}`,
        prompt: clip(prompt.replace(/\s+/g, ' ').trim(), 80),
        startedAt: at,
        startCostUsd: u.costUsd,
        startFiveHour: u.fiveHour,
        work: 0,
        agents: [],
      },
    ].slice(-20),
  )
}

async function changeAgent($: $, id: string, fn: (a: Agent) => Agent) {
  await update($, runs, list =>
    list.map(run =>
      run.agents.some(a => a.id === id)
        ? { ...run, agents: run.agents.map(a => (a.id === id ? fn(a) : a)) }
        : run,
    ),
  )
}

async function changePlan($: $, tool: string, input: Record<string, unknown>) {
  if (tool === 'TodoWrite' && Array.isArray(input.todos)) {
    const todos = input.todos as { content: string; status: StepStatus }[]
    await update($, plan, () => todos.map((t, i) => ({ id: `todo-${i}`, label: t.content, status: t.status })))
    return
  }
  if (tool === 'TaskUpdate' && typeof input.taskId === 'string') {
    const id = `task-${input.taskId}`
    await update($, plan, list =>
      input.status === 'deleted'
        ? list.filter(p => p.id !== id)
        : list.map(p =>
            p.id === id
              ? {
                  ...p,
                  label: typeof input.subject === 'string' ? input.subject : p.label,
                  status: (input.status as StepStatus | undefined) ?? p.status,
                }
              : p,
          ),
    )
    return
  }
  if (tool.endsWith('__update_plan')) {
    if (Array.isArray(input.items)) {
      const items = input.items as { content: string; status: StepStatus }[]
      await update($, plan, () => items.map((t, i) => ({ id: `plan-${i}`, label: t.content, status: t.status })))
      return
    }
    await update($, plan, list => {
      let next = list
      const set = (i: number, status: StepStatus) => {
        next = next.map((p, j) => (j === i ? { ...p, status } : p))
      }
      if (input.advance === true) {
        const at = next.findIndex(p => p.status === 'in_progress')
        if (at >= 0) set(at, 'completed')
        const pending = next.findIndex((p, i) => i > at && p.status === 'pending')
        if (pending >= 0) set(pending, 'in_progress')
      }
      if (Array.isArray(input.done)) {
        for (const n of input.done as number[]) set(n - 1, 'completed')
      }
      if (typeof input.start === 'number') {
        next = next.map(p => (p.status === 'in_progress' ? { ...p, status: 'pending' as const } : p))
        set(input.start - 1, 'in_progress')
      }
      return next
    })
  }
}

async function wrapUp($: $, id: string) {
  try {
    await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: WRAP_UP }] }, agentId: id })
    await changeAgent($, id, a => ({ ...a, wrapRequested: true }))
  } catch {
    // The agent finished before the message could reach it.
    $.ui.toast('That agent had already finished.')
  }
}

// Redraws the panel once a second while any agent runs, so times keep moving.
let ticker: { cancel: () => void } | undefined

async function keepTicking($: $) {
  const list = await read($, runs)
  const running = list.some(r => r.agents.some(a => a.status === 'running'))
  if (running && !ticker) {
    ticker = $.clock.every(1000, () => void update($, now, n => n + 1))
  } else if (!running && ticker) {
    ticker.cancel()
    ticker = undefined
  }
}

// ---------- drawing ----------

// A small pixel creature of the crew's own design: X body, o eyes.
const SPRITE = ['...XXXX...', '.XXXXXXXX.', 'XXoXXXXoXX', 'XXXXXXXXXX', '.XXXXXXXX.', '.X.X..X.X.']

const sprite = (color: string, px = 4) => {
  const rects = SPRITE.flatMap((row, y) =>
    [...row].flatMap((c, x) =>
      c === '.'
        ? []
        : [`<rect x="${x * px}" y="${y * px}" width="${px}" height="${px}" fill="${c === 'o' ? '#ffffff' : color}"/>`],
    ),
  ).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${10 * px}" height="${6 * px}" viewBox="0 0 ${10 * px} ${6 * px}" shape-rendering="crispEdges">${rects}</svg>`
}

// One step's slice of a card's bar, stretched to the room its Box gives it;
// lit is how it looks while the pointer is over it or its step's text.
const segment = (color: string, isOpen: boolean, isLit = false) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 10" width="2000" height="10" preserveAspectRatio="none">` +
  `<rect x="0.5" y="${isLit ? 0 : 2}" width="99" height="${isLit ? 10 : 6}" rx="2" fill="${color}" opacity="${isOpen && !isLit ? 0.5 : 1}"` +
  `${isLit ? ' stroke="#000" stroke-opacity="0.35" stroke-width="1" vector-effect="non-scaling-stroke"' : ''}/></svg>`

// Each step's share of the bar: its time, with a floor so short steps still show.
const widths = (agent: Agent, at: number) => {
  const end = agent.endedAt ?? at
  const raw = agent.steps.map(s => Math.max(1, (s.endedAt ?? end) - s.startedAt))
  const span = raw.reduce((n, d) => n + d, 0) || 1
  // Whole percentages, as a Box's width takes them, summing to 100 at most.
  const floored = raw.map(d => Math.max(2, (d / span) * 100))
  const sum = floored.reduce((n, d) => n + d, 0)
  return floored.map(d => Math.max(1, Math.floor((d / sum) * 100)))
}

const planBar = (done: number, all: number, width = 160) => {
  const w = all ? (done / all) * width : 0
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="8" viewBox="0 0 ${width} 8"><rect width="${width}" height="8" rx="4" fill="#888" opacity="0.25"/><rect width="${w.toFixed(1)}" height="8" rx="4" fill="${RUNNING}"/></svg>`
}

const textBar = (done: number, all: number, cells = 14) => {
  const n = all ? Math.round((done / all) * cells) : 0
  return '█'.repeat(n) + '░'.repeat(cells - n)
}

// ---------- the mod ----------

// The hub's switch for this mod: while it is off nothing is tracked and the prompt gets no Why line.
const isOn = () => isModOn(ID)

export function registerCrew(on: On) {
  // ----- the panel -----

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    const Svg = 'Svg' in els ? els.Svg : undefined
    const list = await read($, runs)
    const items = await read($, plan)
    const u = await read($, usage)
    await read($, now)
    const at = await $.clock.now()
    const run = currentRun(list)
    const agents = run?.agents ?? []

    const running = agents.filter(a => a.status === 'running')
    const finished = agents.filter(a => a.status !== 'running')
    const elapsed = run ? (run.endedAt && running.length === 0 ? run.endedAt : at) - run.startedAt : 0
    const fiveHourDelta =
      u.fiveHour !== undefined && run?.startFiveHour !== undefined ? u.fiveHour - run.startFiveHour : undefined
    // Points of the 5-hour window per unit of weighted work, this request: the
    // window only reports whole points, so a step's share is an estimate.
    const perWork = fiveHourDelta !== undefined && fiveHourDelta > 0 && run && run.work > 0 ? fiveHourDelta / run.work : undefined
    const agentTokens = agents.reduce((n, a) => n + a.tokens, 0)
    const agentCached = agents.reduce((n, a) => n + a.cached, 0)

    const stat = (p: { label: string; value: string; note?: string }) => (
      <Box flexDirection="column" borderStyle="round" borderDimColor paddingX="sm" flexGrow={1}>
        <Text size="caption" dimColor>
          {p.label}
        </Text>
        <Text weight="semibold" color={ACCENT}>
          {p.value}
        </Text>
        {p.note !== undefined && (
          <Text size="caption" dimColor>
            {p.note}
          </Text>
        )}
      </Box>
    )

    const header = (p: { label: string; count: number; color: string }) => (
      <Box backgroundColor={p.color} paddingX="sm">
        <Text weight="bold" color="#ffffff">
          ▾ {p.label} · {p.count}
        </Text>
      </Box>
    )

    const card = (agent: Agent) => {
      const color = hue(agent.color)
      const isRunning = agent.status === 'running'
      const current = agent.steps[agent.steps.length - 1]
      const last = agent.steps.length - 1
      const recent = [last - (isRunning ? 1 : 0), last - (isRunning ? 2 : 1)].filter(i => i >= 0)
      const time = duration((agent.endedAt ?? at) - agent.startedAt)
      const n = `${agent.steps.length} step${agent.steps.length === 1 ? '' : 's'}`
      const statusLine = isRunning
        ? `${agent.wrapRequested ? 'Wrapping up · ' : ''}${current ? `Step ${agent.steps.length} · ${current.label}` : 'Getting started…'}`
        : agent.status === 'done'
          ? `Done · ${n}`
          : agent.status === 'stopped'
            ? `Stopped · ${n}`
            : `Failed · ${n}`
      const statusColor = isRunning ? color : agent.status === 'done' ? RUNNING : '#C92A2A'
      const scope = (i: number) => `crew-${agent.id}-${i}`.slice(0, 64)
      const share = [
        perWork !== undefined ? `≈${percent(agent.work * perWork)} of your 5-hour window` : '',
        run && run.work > 0 ? `${percent((agent.work / run.work) * 100)} of this request` : '',
      ]
        .filter(Boolean)
        .join(' · ')
      const sizes = widths(agent, at)

      return (
        <Box
          key={`card-${agent.id}`}
          flexDirection="row"
          gap="md"
          borderStyle="round"
          borderColor={isRunning ? color : undefined}
          borderDimColor={!isRunning}
          padding="sm"
        >
          {!Svg ? (
            <Text color={color}>■</Text>
          ) : (
            <Box alignItems="center" justifyContent="center">
              <Svg source={sprite(color)} alt={`${agent.name} character`} />
            </Box>
          )}
          <Box flexDirection="column" flexGrow={1} gap="xs">
            <Box flexDirection="row" justifyContent="space-between" alignItems="center">
              <Text weight="bold">{agent.name}</Text>
              {isRunning && !agent.wrapRequested ? (
                <Button key={`wrap-${agent.id}`} label="Wrap up" onPress={() => void wrapUp($, agent.id)} />
              ) : (
                <Text color={isRunning ? RUNNING : statusColor}>{isRunning ? '●' : agent.status === 'done' ? '✓' : '■'}</Text>
              )}
            </Box>
            <Box flexDirection="row" justifyContent="space-between">
              <Text size="caption" dimColor>
                {agent.type} · {agent.model}
              </Text>
              <Text size="caption" dimColor tabular>
                {tokens(agent.tokens)} tokens · {time}
              </Text>
            </Box>
            {share !== '' && (
              <Text size="caption" dimColor>
                {share}
              </Text>
            )}
            {agent.purpose !== '' && (
              <Text size="footnote" italic>
                Why: {agent.purpose}
              </Text>
            )}
            <Text weight="semibold" color={statusColor} wrap="truncate" hover={current ? { scope: scope(last), underline: true } : undefined}>
              {statusLine}
            </Text>
            {recent.map(i => (
              <Text size="footnote" wrap="truncate" hover={{ scope: scope(i), color }}>
                {'  '}
                {agent.steps[i]?.label}
              </Text>
            ))}
            {!Svg ? (
              <Text color={color}>{textBar(agent.steps.filter(s => s.endedAt).length, Math.max(1, agent.steps.length), 24)}</Text>
            ) : agent.steps.length === 0 ? (
              <Svg source={segment(color, true)} alt="No steps yet" height={10} />
            ) : (
              <Box flexDirection="row" width="100%">
                {agent.steps.map((step, i) => (
                  <Box key={scope(i)} width={`${sizes[i] ?? 1}%`} hover={{ scope: scope(i) }}>
                    <Svg source={segment(color, !step.endedAt)} alt={`Step ${i + 1}: ${step.label}`} height={10} />
                    <Box position="absolute" top={0} left={0} right={0} display="none" hover={{ scope: scope(i), display: 'flex' }}>
                      <Svg source={segment(color, !step.endedAt, true)} alt={`Step ${i + 1}, highlighted`} height={10} />
                    </Box>
                  </Box>
                ))}
              </Box>
            )}
            {agent.steps.map((step, i) => {
              const took = duration((step.endedAt ?? agent.endedAt ?? at) - step.startedAt)
              const ofAgent = agent.work > 0 ? `${percent((step.work / agent.work) * 100)} of this agent's usage` : ''
              const ofWindow = perWork !== undefined ? `≈${percent(step.work * perWork)} of your 5-hour window` : ''
              return (
                <Box flexDirection="column" display="none" hover={{ scope: scope(i), display: 'flex' }}>
                  <Text size="footnote" weight="semibold" color={color}>
                    Step {i + 1} · {step.label}
                    {step.endedAt ? '' : ' · in progress'}
                  </Text>
                  <Text size="caption" dimColor>
                    {took} · {tokens(step.tokens)} new tokens · {tokens(step.cached)} re-read from cache
                  </Text>
                  {(ofAgent || ofWindow) && (
                    <Text size="caption" dimColor>
                      {[ofAgent, ofWindow].filter(Boolean).join(' · ')}
                    </Text>
                  )}
                </Box>
              )
            })}
          </Box>
        </Box>
      )
    }

    const done = items.filter(p => p.status === 'completed').length
    const everyAgent = list.flatMap(r => r.agents)

    return (
      <Box flexDirection="column" gap="md" padding="sm">
        <Text weight="semibold" size="heading" color={ACCENT}>
          {agents.length === 1 ? '1 sub-agent' : `${agents.length} sub-agents`} in this request
        </Text>
        {run && run.prompt !== '' && (
          <Text size="footnote" dimColor wrap="truncate">
            “{run.prompt}”
          </Text>
        )}
        {agents.length > 0 && (
          <Text size="caption" dimColor>
            Hover a card's bar to see each step's time and usage.
          </Text>
        )}

        <Box flexDirection="row" gap="sm">
          {stat({ label: 'Chat cost', value: u.costUsd !== undefined ? `$${u.costUsd.toFixed(2)}` : '—', note: 
              u.costUsd !== undefined && run?.startCostUsd !== undefined
                ? `+$${(u.costUsd - run.startCostUsd).toFixed(2)} this request`
                : undefined
             })}
          {stat({ label: 'Sub-agent tokens', value: tokens(agentTokens), note: agentCached > 0 ? `+${tokens(agentCached)} re-read from cache` : undefined })}
          {stat({ label: 'Time', value: duration(elapsed) })}
          {stat({ label: '5-hour window', value: u.fiveHour !== undefined ? `${Math.round(u.fiveHour)}%` : '—', note: 
              fiveHourDelta !== undefined
                ? `+${Math.max(0, Math.round(fiveHourDelta))}% this request`
                : u.sevenDay !== undefined
                  ? `7-day ${Math.round(u.sevenDay)}%`
                  : undefined
             })}
        </Box>

        {items.length > 0 && (
          <Box flexDirection="column" gap="xs">
            <Box flexDirection="row" gap="sm" alignItems="center">
              <Text weight="bold">
                Plan · {done} of {items.length} done
              </Text>
              {Svg && <Svg source={planBar(done, items.length, 120)} alt={`${done} of ${items.length} done`} />}
            </Box>
            {items.map((p: PlanItem) => {
              const helpers = everyAgent.filter(a => a.planItemId === p.id)
              return (
                <Box flexDirection="row" justifyContent="space-between">
                  <Text
                    color={p.status === 'in_progress' ? ACCENT : undefined}
                    dimColor={p.status === 'completed'}
                    strikethrough={p.status === 'completed'}
                    wrap="truncate"
                  >
                    {p.status === 'completed' ? '✓' : p.status === 'in_progress' ? '▸' : '○'} {p.label}
                  </Text>
                  <Text>
                    {helpers.map(a => (
                      <Text color={hue(a.color)}>■</Text>
                    ))}
                  </Text>
                </Box>
              )
            })}
          </Box>
        )}

        {agents.length === 0 && (
          <Text dimColor>
            No sub-agents in this request yet. When Claude hands work to a sub-agent, its card appears here.
          </Text>
        )}

        {running.length > 0 && header({ label: 'Running', count: running.length, color: RUNNING })}
        {running.map(card)}

        {finished.length > 0 && header({ label: 'Finished', count: finished.length, color: FINISHED })}
        {finished.map(card)}
      </Box>
    )
  })
}

// ---------- this mod's part of the events every mod shares (hooks/mods/index.ts chains them) ----------

export async function crewPromptCompose($: EngineInterface, e: ArgOf<'prompt.compose'>, next: NextOf<'prompt.compose'>) {
  const res = await next(e)
  if (!isOn() || !e.tools.includes('Agent')) return res
  return { sections: [...res.sections, { id: 'crew:why', text: WHY_PROMPT, scope: 'session' as const }] }
}

export async function crewPromptSubmit($: EngineInterface, e: ArgOf<'prompt.submit'>, next: NextOf<'prompt.submit'>) {
  const res = await next(e)
  if (isOn() && e.text.trim() && !e.text.trim().startsWith('/')) await startRun($, e.text)
  return res
}

export async function crewSessionMeasure($: EngineInterface, e: ArgOf<'session.measure'>, next: NextOf<'session.measure'>) {
  if (!isOn()) return next(e)
  const find = (kind: string) => e.rateLimits.find(r => r.kind === kind)?.percentUsed
  const reading: Usage = { costUsd: e.cost?.usd, fiveHour: find('five_hour'), sevenDay: find('seven_day') }
  await update($, usage, old => ({ ...old, ...Object.fromEntries(Object.entries(reading).filter(([, v]) => v !== undefined)) }))
  return next(e)
}

export async function crewAgentSpawn($: EngineInterface, e: ArgOf<'agent.spawn'>, next: NextOf<'agent.spawn'>) {
  const res = await next(e)
  if (!isOn() || res.deny !== undefined || !res.agentId || e.workflow || e.resume) return res

  const at = await $.clock.now()
  const { purpose, brief } = parseWhy(e.prompt)
  const active = (await read($, plan)).find(p => p.status === 'in_progress')
  if ((await read($, runs)).length === 0) await startRun($, '')

  const agent: Agent = {
    id: res.agentId,
    name: e.name ?? e.description,
    type: e.subagentType,
    model: modelName(res.model),
    purpose,
    brief,
    color: 0,
    planItemId: active?.id,
    status: 'running',
    startedAt: at,
    tokens: 0,
    cached: 0,
    work: 0,
    steps: [],
  }
  await update($, runs, list => {
    const run = currentRun(list)
    if (!run) return list
    const used = list.reduce((n, r) => n + r.agents.length, 0)
    return [...list.slice(0, -1), { ...run, agents: [...run.agents, { ...agent, color: used % COLORS.length }] }]
  })
  await keepTicking($)
  return res
}

export async function crewSessionAppend($: EngineInterface, e: ArgOf<'session.append'>, next: NextOf<'session.append'>) {
  const res = await next(e)
  if (!isOn()) return res
  try {
    const at = await $.clock.now()
    for (const block of e.message.content) {
      if (e.message.type === 'assistant' && block.type === 'tool_use') {
        const tool = String(block.name)
        const input = (block.input ?? {}) as Record<string, unknown>
        if (e.agentId) {
          await changeAgent($, e.agentId, a => {
            const last = a.steps[a.steps.length - 1]
            const step: Step = {
              id: String(block.id),
              label: describe(tool, input),
              tool,
              startedAt: last ? (last.endedAt ?? at) : a.startedAt,
              tokens: 0,
              cached: 0,
              work: 0,
            }
            return { ...a, steps: [...a.steps, step] }
          })
        } else {
          await changePlan($, tool, input)
          if (tool === 'TaskCreate' && typeof input.subject === 'string') pendingTasks.set(String(block.id), input.subject)
        }
      }
      if (block.type === 'tool_result') {
        const id = String(block.tool_use_id)
        if (e.agentId) {
          await changeAgent($, e.agentId, a => ({
            ...a,
            steps: a.steps.map(s => (s.id === id && !s.endedAt ? { ...s, endedAt: at } : s)),
          }))
        } else if (pendingTasks.has(id)) {
          const text = JSON.stringify(block.content ?? '')
          const num = /#(\d+)/.exec(text)?.[1]
          const subject = pendingTasks.get(id)!
          pendingTasks.delete(id)
          if (num) {
            await update($, plan, list => [
              ...list.filter(p => p.id !== `task-${num}`),
              { id: `task-${num}`, label: subject, status: 'pending' as const },
            ])
          }
        }
      }
    }
  } catch {
    // Watching only: never let the panel's bookkeeping disturb the session.
  }
  return res
}

export async function* crewTurnStep($: EngineInterface, e: ArgOf<'turn.step'>, next: NextOf<'turn.step'>) {
  const result = yield* next(e)
  if (isOn() && result.usage) {
    const used = split(result.usage)
    const add = <T extends { tokens: number; cached: number; work: number }>(x: T): T => ({
      ...x,
      tokens: x.tokens + used.tokens,
      cached: x.cached + used.cached,
      work: x.work + used.work,
    })
    // A reply's cost belongs to the step it decides on: the one still open.
    if (e.agentId) {
      await changeAgent($, e.agentId, a => {
        const steps = a.steps.slice()
        const last = steps[steps.length - 1]
        if (last) steps[steps.length - 1] = add(last)
        return { ...add(a), steps }
      })
    }
    await update($, runs, list => {
      const run = currentRun(list)
      return run ? [...list.slice(0, -1), { ...run, work: run.work + used.work }] : list
    })
  }
  return result
}

export async function crewTurnComplete($: EngineInterface, e: ArgOf<'turn.complete'>, next: NextOf<'turn.complete'>) {
  if (!isOn()) return next(e)
  const at = await $.clock.now()
  if (e.agentId) {
    const status = e.reason === 'aborted' ? 'stopped' : e.reason === 'answer' ? 'done' : 'failed'
    await changeAgent($, e.agentId, a => ({
      ...a,
      status,
      endedAt: at,
      steps: a.steps.map(s => (s.endedAt ? s : { ...s, endedAt: at })),
    }))
    await keepTicking($)
  } else {
    await update($, runs, list => {
      const run = currentRun(list)
      return run ? [...list.slice(0, -1), { ...run, endedAt: at }] : list
    })
  }
  return next(e)
}

export const crew: Mod = {
  id: ID,
  name: 'Progress',
  icon: '▤',
  pane: { id: PANE },
  description: "Claude's plan and what each sub-agent is doing, why, and how far along it is.",
}

export async function crewBadge($: EngineInterface, e: BandInput): Promise<Badge | null> {
  const agents = currentRun(await read($, runs))?.agents ?? []
  const working = agents.filter(a => a.status === 'running').length
  return working > 0 ? { glyph: `●${working}`, color: RUNNING, label: `${working} sub-agent${working === 1 ? '' : 's'} working` } : null
}

// The plan's bar as the headline (or the crew's dots, with no plan), then the dots and a line per agent still working.
export async function crewView($: EngineInterface, e: BandInput): Promise<ModView> {
  const els = $.ui.resolve(e)
  const { Box, Text } = els
  // The terminal draws no Svg; it gets text stand-ins.
  const Svg = 'Svg' in els ? els.Svg : undefined
  const muted = hubColors().muted
  const run = currentRun(await read($, runs))
  const items = await read($, plan)
  const agents = run?.agents ?? []
  if (agents.length === 0 && items.length === 0) {
    return {
      headline: <Text color={muted} dimColor={!muted} wrap="truncate">Nothing in progress. Claude's plan and any sub-agents show here while it works.</Text>,
      rows: [],
    }
  }

  const done = items.filter(p => p.status === 'completed').length
  const active = items.find(p => p.status === 'in_progress')
  const working = agents.filter(a => a.status === 'running')
  const finished = agents.length - working.length
  const dots = agents.length > 0 ? (
    <Text>
      {agents.map(a => (
        <Text color={hue(a.color)}>{a.status === 'running' ? '●' : '○'}</Text>
      ))}{' '}
      <Text color={muted} dimColor={!muted}>
        {working.length > 0 ? `${working.length} working` : ''}
        {working.length > 0 && finished > 0 ? ' · ' : ''}
        {finished > 0 ? `${finished} finished` : ''}
      </Text>
    </Text>
  ) : null
  const rows: Row[] = []
  if (items.length > 0 && dots) rows.push(dots)
  for (const a of working) {
    const current = a.steps[a.steps.length - 1]
    rows.push(
      <Text wrap="truncate">
        <Text color={hue(a.color)}>{`● ${a.name}`}</Text>
        <Text color={muted} dimColor={!muted}>{` · ${a.wrapRequested ? 'wrapping up · ' : ''}${current ? current.label : 'getting started…'}`}</Text>
      </Text>,
    )
  }
  const headline = items.length > 0 ? (
    <Box flexDirection="row" alignItems="center" gap={1}>
      <Box flexShrink={0}><Text>{`Plan ${done}/${items.length}`}</Text></Box>
      <Box flexShrink={0}>
        {!Svg ? (
          <Text color={RUNNING}>{textBar(done, items.length)}</Text>
        ) : (
          <Svg source={planBar(done, items.length, 120)} alt={`${done} of ${items.length} plan steps done`} />
        )}
      </Box>
      {active && <Box flexShrink={1}><Text color={muted} dimColor={!muted} wrap="truncate">▸ {active.label}</Text></Box>}
    </Box>
  ) : (dots ?? <Text> </Text>)
  return { headline, rows }
}

export async function crewOpenPane($: EngineInterface): Promise<void> {
  await $.ui.open({ id: PANE, title: TITLE })
}

export async function crewDisable($: EngineInterface): Promise<void> {
  ticker?.cancel()
  ticker = undefined
}

// TaskCreate calls waiting on their result, which carries the task's number.
const pendingTasks = new Map<string, string>()

