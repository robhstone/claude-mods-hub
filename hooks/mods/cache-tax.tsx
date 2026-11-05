import type { EngineInterface, On } from 'claude-code'
import { hubColors, isModOn, offText, setLook, type BandInput, type ArgOf, type Badge, type Mod, type ModView, type NextOf, type Row } from '../hub'
import { statusIcons } from './status-icons'

const TTL_MS = 60 * 60 * 1000
const PING_AFTER_MS = 50 * 60 * 1000
const MIN_PING_MS = 60 * 1000
const MAX_RETRIES = 3
const AUTO_WARM_MS = 3 * 60 * 60 * 1000
const DEFAULT_WINDOW_MS = 6 * 60 * 60 * 1000
const BIG_TOKENS = 50000
const PING_PROMPT = 'Reply with the single word: warm'
const KEY_DEADLINE = 'deadline'
const KEY_EVERY = 'every'
const KEY_GUARD = 'guard'
const KEY_ALWAYS = 'always'
const KEY_DETAILS = 'band-details'
const PANE = 'cache-tax'
const ID = 'cache-tax'

// Prompts no person sent, so nobody could send them again after a refusal. Every
// other origin, including sdk, unclassified and the owner's own Slack or channel
// messages, may carry a person's words and keeps the guard.
const UNATTENDED = new Set(['task-notification', 'scheduled-trigger', 'peer', 'peer-send-message', 'projects-relay', 'coordinator', 'observer', 'observer-activity'])

const LONG_PROMPT_TOKENS = 100000

// $ per million tokens, [cache read, 1h cache write, output], list prices October 2026.
// More specific families first: a model id takes the first row it matches.
const PRICES: Array<[string | RegExp, number, number, number]> = [
  ['fable-5-1', 0.25, 20, 50],
  ['mythos-5-1', 0.25, 20, 50],
  ['fable-5', 1, 20, 50],
  ['mythos-5', 1, 20, 50],
  ['opus-5-5', 0.2, 8, 20],
  ['opus-5', 0.5, 10, 25],
  // Opus 4 and 4.1 in every spelling (claude-opus-4-1-20250805, claude-opus-4@20250514, the -0 and -1 aliases), never Opus 4.5 and later.
  [/opus-4(?:-[01])?(?:$|[^-\d]|-20\d{6})/, 1.5, 30, 75],
  ['opus-4', 0.5, 10, 25],
  ['sonnet-5-5', 0.1, 4, 10],
  ['sonnet-5', 0.2, 4, 10],
  ['sonnet', 0.3, 6, 15],
  ['haiku-5-5', 0.01, 0.2, 0.5],
  ['3-5-haiku', 0.08, 1.6, 4],
  ['haiku-3-5', 0.08, 1.6, 4],
  ['haiku', 0.1, 2, 5],
]

// A request whose prompt, cache reads and writes included, is over 100k tokens pays these instead.
const LONG_PRICES: Array<[string, number, number, number]> = [
  ['haiku-5-5', 0.05, 1, 2.5],
]

type PingRecord = { at: number; read: number; write: number; usd: number | null; warm: boolean }
type Miss = { at: number; tokens: number; usd: number | null }
type GuardMode = 'refuse' | 'warn'

export type State = {
  hasBand: boolean
  sid: string
  deadline: number
  every: number
  always: boolean
  lastRequestAt: number
  lastModel: string | null
  ctx: number
  compacted: boolean
  resumedAt: number
  transcript: number
  guard: GuardMode
  ackedAt: number
  coldWritePending: boolean
  misses: Miss[]
  pending: { cancel: () => void } | null
  last: PingRecord | null
  /** The last few ping receipts, newest last, for the pane's log. */
  pings: PingRecord[]
  stopped: string | null
  waitForTurn: boolean
  retries: number
  retryReason: string
  gen: number
  tick: number
  offs: number
  turnOffs: number | null
  inFlight: boolean
  stepWrites: StepWrites | null
  steps: number
  endingSid: string
}

/** What this turn's main requests wrote before any compaction it saw, priced per request where the steps reported usage. */
type StepWrites = { tokens: number; usd: number; priced: boolean }

function priceOf(model: string | null, promptTokens: number): [number, number, number] | null {
  const m = (model ?? '').toLowerCase().replace(/[\s.]+/g, '-')
  if (promptTokens > LONG_PROMPT_TOKENS) {
    for (const [family, read, write, output] of LONG_PRICES) if (m.includes(family)) return [read, write, output]
  }
  for (const [family, read, write, output] of PRICES) {
    if (typeof family === 'string' ? m.includes(family) : family.test(m)) return [read, write, output]
  }
  return null
}

export function parseDuration(text: string): number | null {
  const m = /^(?:(\d+)h)?(?:(\d+)m)?$/.exec(text.trim())
  if (!m || (m[1] === undefined && m[2] === undefined)) return null
  return (Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0)) * 60 * 1000
}

export function fmtDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 60000))
  const h = Math.floor(total / 60)
  const m = total % 60
  if (h >= 48) return `${Math.floor(h / 24)}d ${h % 24}h`
  return h > 0 ? `${h}h${String(m).padStart(2, '0')}m` : `${m}m`
}

function fmtUsd(usd: number | null): string {
  return usd == null ? 'n/a' : '$' + (usd >= 100 ? usd.toFixed(0) : usd.toFixed(2))
}

function fmtTok(n: number): string {
  return n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1000 ? Math.round(n / 1000) + 'k' : String(n)
}

function coldUsd(s: State): number | null {
  const price = priceOf(s.lastModel, s.ctx)
  return price ? s.ctx * price[1] / 1e6 : null
}

function warmUsd(s: State): number | null {
  const price = priceOf(s.lastModel, s.ctx)
  return price ? s.ctx * price[0] / 1e6 : null
}

/** Everything a fork bills: the cache read, any cache write, uncached input at the base rate (half the 1h write rate), and the output. */
function pingUsd(u: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }, price: [number, number, number]): number {
  return (u.cache_read_input_tokens * price[0] + u.cache_creation_input_tokens * price[1] + u.input_tokens * price[1] / 2 + u.output_tokens * price[2]) / 1e6
}

/** The read-only upper bound: pings at the cache-read rate that cost as much as one cold write of the same context. */
function breakEvenPings(s: State): number | null {
  const price = priceOf(s.lastModel, s.ctx)
  if (!price || s.ctx <= 0) return null
  return Math.floor(price[1] / price[0])
}

function isCold(s: State, now: number): boolean {
  return s.lastRequestAt > 0 && !s.compacted && now - s.lastRequestAt >= TTL_MS
}

function guardText(s: State, now: number): string {
  const price = priceOf(s.lastModel, s.ctx)
  const rate = price ? `$${price[1]}/MTok` : 'the cache-write rate'
  const warm = warmUsd(s)
  return `the prompt cache went cold ${fmtDuration(now - s.lastRequestAt - TTL_MS)} ago. Sending this re-writes ` +
    `up to ${s.ctx.toLocaleString('en-US')} tokens at ${rate} = ${fmtUsd(coldUsd(s))}` +
    (warm == null ? '' : ` (a warm turn would have cost ${fmtUsd(warm)})`) + '.'
}

export type ResumeFields = {
  source: string
  model?: string
  context_tokens?: number
  seconds_since_last_response?: number
  prompt_cache_likely_expired?: boolean
  estimated_cache_write_usd?: number
}

/** /clear starts a new conversation in the same process; nothing priced before it still exists. */
export function resetForClear(s: State) {
  s.ctx = 0
  s.lastRequestAt = 0
  s.compacted = false
  s.resumedAt = 0
  s.transcript = 0
  s.ackedAt = 0
  s.coldWritePending = false
  s.misses = []
  s.pings = []
  s.waitForTurn = false
  s.stepWrites = null
  s.steps = 0
  outdate(s)
  disarm(s)
}

/** Applies a resumed session's fields to the state; returns the line to log, if any. */
export function seedFromResume(s: State, e: ResumeFields, now: number): string | null {
  if (e.source !== 'resume' && e.source !== 'fork') return null
  if (typeof e.context_tokens === 'number' && e.context_tokens > 0) s.ctx = e.context_tokens
  if (typeof e.seconds_since_last_response === 'number') {
    s.lastRequestAt = now - e.seconds_since_last_response * 1000
    s.resumedAt = 0
  }
  if (typeof e.model === 'string') s.lastModel = e.model
  s.compacted = false
  if (e.prompt_cache_likely_expired !== true || s.ctx < BIG_TOKENS) return null
  const usd = typeof e.estimated_cache_write_usd === 'number' ? fmtUsd(e.estimated_cache_write_usd) : fmtUsd(coldUsd(s))
  return `resuming cold. The first message re-writes ${s.ctx.toLocaleString('en-US')} tokens, about ${usd}. /clear and paste a summary if you only need the conclusions.`
}

/** A transcript resumed without the time of its last response: that response came after its first launch, so an hour after that launch the cache may be cold. */
function mayBeCold(s: State, now: number): boolean {
  return s.resumedAt > 0 && !s.lastRequestAt && now - s.resumedAt >= TTL_MS
}

/** The line for a resumed session whose last response time never arrived: the cache may be cold, and this is what that would cost. */
function unknownText(s: State): string {
  const price = priceOf(s.lastModel, s.ctx)
  const rate = price ? `$${price[1]}/MTok` : 'the cache-write rate'
  return `resumed with up to ${s.ctx.toLocaleString('en-US')} tokens of context and no time of its last response, so the cache may be cold. ` +
    `If it is, this message re-writes them at ${rate} = ${fmtUsd(coldUsd(s))}.`
}

/** The conversation was summarized: the next request is the first over the new prefix, and a ping out for the old one is dropped. */
function markCompacted(s: State) {
  s.compacted = true
  s.transcript = 0
  s.ackedAt = 0
  outdate(s)
}

function statusText(s: State, now: number): string | undefined {
  if (s.stopped) return `keepwarm stopped: ${s.stopped}`
  if (!s.deadline) return undefined
  const pingText = s.last ? ` · last ping read ${fmtTok(s.last.read)} ${fmtUsd(s.last.usd)}` : ''
  const nextText = !s.lastRequestAt ? ' · waiting for the first turn'
    : s.compacted ? ' · waiting for the first turn after compaction'
    : isCold(s, now) ? ` · cold now, first ping ${fmtDuration(s.every)} after the next turn`
    : s.waitForTurn ? ' · nothing to fork yet, first ping after the next turn'
    : s.retries ? ` · API busy, ping retry ${s.retries} of ${MAX_RETRIES}`
    : ` · ping in ${fmtDuration(s.lastRequestAt + s.every - now)}`
  return `keepwarm ${fmtDuration(s.deadline - now)} left${nextText}${pingText}`
}

function updateStatus($: EngineInterface, s: State, now: number) {
  if (s.hasBand) $.ui.invalidate('ui.render')
  else $.ui.status(isOn() ? statusText(s, now) : undefined)
}

/** Cancels the timer. Every new timer is set right after this, so the tick also says the schedule changed. */
function disarm(s: State) {
  if (s.pending) s.pending.cancel()
  s.pending = null
  s.tick++
}

/** Outdates any ping in flight: /clear, a resume, compaction or stop replaced the state it was sent for. Re-arming or extending the window does not, so a ping out at that moment still counts; a main request outdates it through the request clock. */
function outdate(s: State) {
  s.gen++
}

// The window and its ping period belong to the session that armed them, so a
// second session, or one resumed from another transcript, never inherits them
// and cannot turn them off. The always switch and the guard mode stay global.
function deadlineKey(s: State): string {
  return `${KEY_DEADLINE}:${s.sid}`
}

function everyKey(s: State): string {
  return `${KEY_EVERY}:${s.sid}`
}

/** Clears this session's own dead window and the bare keys a store written before 2.1.1 still holds. Other sessions' keys are never touched: a read followed by a delete cannot be made atomic against their renewal. */
async function prune($: EngineInterface, s: State, now: number) {
  for (const key of [KEY_DEADLINE, deadlineKey(s)]) {
    const deadline = await $.store.get(key)
    if (deadline === undefined) continue
    if (typeof deadline === 'number' && deadline > now) continue
    await $.store.delete(key)
    await $.store.delete(KEY_EVERY + key.slice(KEY_DEADLINE.length))
  }
}

async function stop($: EngineInterface, s: State, why: string | null, forgetAlways = false) {
  // Set before any await, so a window being opened at the same moment sees the off and does not write itself back.
  if (forgetAlways) {
    s.always = false
    s.offs++
  }
  s.deadline = 0
  s.every = PING_AFTER_MS
  s.stopped = why
  s.retries = 0
  outdate(s)
  disarm(s)
  await $.store.delete(deadlineKey(s))
  await $.store.delete(everyKey(s))
  if (forgetAlways) await $.store.delete(KEY_ALWAYS)
  updateStatus($, s, await $.clock.now())
}

/** The conversation ended under /clear or an in-process resume. The next one's id cannot be read until the engine has switched, so the state is left unseated. */
async function endConversation($: EngineInterface, s: State, reason: 'clear' | 'resume') {
  // Claimed before any await: a second end or a classic start for the same conversation finds it already gone, and an
  // end cut short by its budget leaves no timer and no old id behind, only the keys below.
  const keys = [deadlineKey(s), everyKey(s)]
  const ending = s.sid
  resetForClear(s)
  s.sid = ''
  s.endingSid = ending
  // /clear ends the conversation the window was armed for. A resume carries the window on to the next one, under its
  // id: the old id's keys go here, or a /keepwarm off there could never find them and the old session would re-arm them.
  if (reason === 'clear') {
    s.deadline = 0
    s.every = PING_AFTER_MS
    s.stopped = null
    s.retries = 0
  }
  for (const key of keys) await $.store.delete(key)
  if (reason === 'clear') updateStatus($, s, await $.clock.now())
}

/** Reads the session the process runs now: its id, its model and the engine's figures for its context. Returns the time read with them. */
async function seat($: EngineInterface, s: State, id?: string): Promise<number> {
  s.sid = id ?? await $.session.id()
  s.endingSid = ''
  s.lastModel = await $.session.model()
  const usage = await $.session.usage()
  const now = await $.clock.now()
  if (usage.context.tokens) s.ctx = usage.context.tokens
  // A resumed transcript's last response came somewhere between its first launch and now; only the resume fields say where.
  s.resumedAt = !s.lastRequestAt && usage.context.tokens ? usage.startedAt : 0
  return now
}

/** Seats the state in the conversation that followed a /clear or a resume, once, and arms what always or a window opened meanwhile asks for. */
async function reseat($: EngineInterface, s: State) {
  if (s.sid) return
  const id = await $.session.id()
  // The host still answers with the conversation being ended: the next one is not there to seat yet, so nothing is
  // seated under the old id, and a window opened meanwhile waits in memory for the id it belongs to.
  if (id === s.endingSid) return
  const now = await seat($, s, id)
  if (s.always) await startWindow($, s, DEFAULT_WINDOW_MS, PING_AFTER_MS)
  // A window carried over, or armed while the conversation was ending, is written under this id.
  else if (s.deadline) await startWindow($, s, s.deadline - now, s.every)
  else updateStatus($, s, now)
}

async function arm($: EngineInterface, s: State) {
  disarm(s)
  s.retries = 0
  if (!s.deadline || !isOn()) return
  const now = await $.clock.now()
  // A timer set while the clock was read, such as a retry, is replaced here, never left running beside this one;
  // from this line to the assignment below nothing awaits.
  disarm(s)
  s.retries = 0
  if (now >= s.deadline) return stop($, s, null)
  // A cold window still needs expiry cleanup, but must not send a model request.
  if (s.lastRequestAt && !s.compacted && !isCold(s, now)) {
    const untilCold = s.lastRequestAt + TTL_MS - now
    // Waiting for a turn sends nothing, but wakes when the cache goes cold so the row says so.
    if (s.waitForTurn) s.pending = $.clock.after(Math.min(s.deadline - now, untilCold), () => { void arm($, s) })
    else {
      const delay = Math.min(s.deadline - now, untilCold, Math.max(1000, s.lastRequestAt + s.every - now))
      s.pending = $.clock.after(delay, () => { void ping($, s) })
    }
  } else {
    s.pending = $.clock.after(s.deadline - now, () => { void arm($, s) })
  }
  updateStatus($, s, now)
}

async function ping($: EngineInterface, s: State) {
  s.pending = null
  if (!s.deadline || !isOn()) return
  const tick = s.tick
  const now = await $.clock.now()
  // A timer set or cancelled while the clock was read (an extension, a retry, a turn) owns the window now;
  // if that left no timer, a window still open is armed again rather than left without one.
  if (s.tick !== tick) return s.pending || s.inFlight ? undefined : arm($, s)
  // One fork at a time: the one already out re-arms when it settles. Checked after the await, and set
  // below with no await in between, so two timers can never both send.
  if (s.inFlight) return
  if (now >= s.deadline) return arm($, s)
  if (isCold(s, now)) return arm($, s)
  if (s.compacted || s.waitForTurn || !s.lastRequestAt) return arm($, s)
  // A request since this timer was set moved the clock; schedule from it.
  if (now - s.lastRequestAt < s.every - 1000) return arm($, s)
  // A host that slept past a retry's slot must not send it inside the last minute.
  if (s.retries && now >= s.lastRequestAt + TTL_MS - MIN_PING_MS) return stop($, s, s.retryReason + afterRetries(s.retries))
  const gen = s.gen
  const sentAt = s.lastRequestAt
  s.inFlight = true
  const sent = await $.model.fork({ prompt: PING_PROMPT }).then(reply => ({ reply }), (err: unknown) => ({ err }))
  const at = await $.clock.now()
  s.inFlight = false
  // Checked after the last await. A stop, /clear, resume or compaction, or a main request that moved the
  // cache clock, replaced what this fork was sent for: its reply is dropped and the window armed afresh.
  if (gen !== s.gen || s.lastRequestAt !== sentAt) return s.pending ? undefined : arm($, s)
  if ('err' in sent) return stop($, s, `the ping failed, ${sent.err instanceof Error ? sent.err.message : String(sent.err)}`)
  const reply = sent.reply
  if (reply === null) return stop($, s, 'the engine did not send the ping, either the snapshot was cold or the API call failed')
  if (reply.isAnswered === false) {
    // A restarted process has no conversation to fork until its first turn; the window waits for one instead of ending.
    if (reply.reason === 'nothing-to-fork') {
      s.waitForTurn = true
      return arm($, s)
    }
    const reason = reply.reason === 'api-error' ? `the API call failed${reply.status === null ? '' : ` (${reply.status})`}`
      : reply.reason === 'aborted' ? 'the ping was interrupted'
      : 'the ping returned no text'
    // A busy or failing API is usually brief; retry while a ping can still land a minute before the cache goes cold.
    if (reply.reason === 'api-error' && (reply.status === null || reply.status === 429 || reply.status >= 500)) {
      const wait = MIN_PING_MS * 2 ** s.retries
      if (s.retries < MAX_RETRIES && at + wait < Math.min(s.deadline, s.lastRequestAt + TTL_MS - MIN_PING_MS)) {
        s.retries++
        s.retryReason = reason
        // Replaces any timer set while the fork was out, such as a window extension's, so only the retry fires.
        disarm(s)
        s.pending = $.clock.after(wait, () => { void ping($, s) })
        updateStatus($, s, at)
        return
      }
    }
    return stop($, s, reason + afterRetries(s.retries))
  }
  const u = reply.usage
  const price = priceOf(s.lastModel, u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens)
  // A warm ping reads the prefix and writes only its own message; a write of a tenth of the read or more means the prefix broke.
  const warm = u.cache_read_input_tokens > 0 && u.cache_creation_input_tokens < 0.1 * u.cache_read_input_tokens
  const usd = price ? pingUsd(u, price) : null
  s.last = { at: now, read: u.cache_read_input_tokens, write: u.cache_creation_input_tokens, usd, warm }
  s.pings = [...s.pings, s.last].slice(-8)
  if (!warm) return stop($, s, `the ping read ${fmtTok(u.cache_read_input_tokens)} and wrote ${fmtTok(u.cache_creation_input_tokens)} tokens (${fmtUsd(usd)}), the cache was already gone`)
  s.lastRequestAt = now
  await arm($, s)
}

function afterRetries(n: number): string {
  return n ? ` after ${n} ${n === 1 ? 'retry' : 'retries'}` : ''
}

/** The reply to an arming command; on a cold cache it says when the first ping can come. */
/** How long keepwarm holds the cache after a paid cold write: the rolling window when always is on. */
function holdMs(s: State): number {
  return s.always ? DEFAULT_WINDOW_MS : AUTO_WARM_MS
}

function armedText(s: State, now: number, windowMs: number): string {
  if (isCold(s, now)) return `keepwarm on for ${fmtDuration(windowMs)}. The cache is cold now, so the first ping comes ${fmtDuration(s.every)} after the next turn`
  return `keepwarm on for ${fmtDuration(windowMs)}, a ping ${fmtDuration(s.every)} after each idle stretch keeps the cache read, not re-written`
}

// A /keepwarm off after `offs` was read wins: the window it cancelled is not written back. A caller that awaited
// before deciding to open a window passes the count it read first.
async function startWindow($: EngineInterface, s: State, windowMs: number, every: number, offs = s.offs) {
  if (s.offs !== offs) return
  const now = await $.clock.now()
  if (s.offs !== offs) return
  const deadline = now + windowMs
  s.every = every
  s.deadline = deadline
  s.stopped = null
  // Unseated, between a conversation's end and the host reporting the next, the window has no id to be written under; the seat writes it.
  if (!s.sid) return arm($, s)
  if (every === PING_AFTER_MS) await $.store.delete(everyKey(s))
  else await $.store.set(everyKey(s), every)
  await $.store.set(deadlineKey(s), deadline)
  if (s.offs !== offs) {
    // Remove only what this call wrote; a window armed after the off is left alone.
    if ((await $.store.get(deadlineKey(s))) === deadline) {
      await $.store.delete(deadlineKey(s))
      if (!s.deadline) await $.store.delete(everyKey(s))
    }
    return
  }
  await arm($, s)
}

function card(s: State, now: number): string {
  const lines: string[] = []
  lines.push(`${s.lastModel ?? 'model not seen yet'}`)
  if (s.compacted) lines.push('state       reset by compaction, waiting for the first turn')
  else if (s.resumedAt) lines.push(mayBeCold(s, now) ? 'state       unknown, resumed without the time of its last response' : `state       resumed without the time of its last response, warm for up to ${fmtDuration(s.resumedAt + TTL_MS - now)} more`)
  else if (!s.lastRequestAt) lines.push('state       no request yet this session')
  else if (isCold(s, now)) lines.push(`state       COLD, last request ${fmtDuration(now - s.lastRequestAt)} ago`)
  else lines.push(`state       warm, ${fmtDuration(s.lastRequestAt + TTL_MS - now)} left`)
  lines.push(`context     ${s.ctx.toLocaleString('en-US')} tokens`)
  lines.push(`cold cost   ${fmtUsd(coldUsd(s))} to re-write it (warm turn ${fmtUsd(warmUsd(s))})`)
  const always = s.always ? ' (always)' : ''
  const idle = s.always ? 'off until the next turn, which arms 6h00m (always)' : 'off (/keepwarm to arm it for 6h00m)'
  lines.push(`keepwarm    ${s.deadline ? (statusText(s, now) ?? '').replace(/^keepwarm /, 'on, ') + always : s.stopped ? `stopped, ${s.stopped}${always}` : idle}`)
  const pings = breakEvenPings(s)
  if (pings != null) lines.push(`break-even  up to ${pings} pings at the read rate cost one cold write, about ${fmtDuration(pings * s.every)} of idle at one ping per ${fmtDuration(s.every)}`)
  lines.push(`guard       ${s.guard === 'refuse' ? 'refuse once (/cache-tax guard warn to only show the price)' : 'warn only (/cache-tax guard refuse to be stopped once)'}`)
  const paid = s.misses.reduce((a, m) => a + (m.usd ?? 0), 0)
  lines.push(`session     ${s.misses.length} cold write${s.misses.length === 1 ? '' : 's'} paid, ${fmtUsd(paid)}`)
  return lines.join('\n')
}

let paneOpen = false
let refreshing = false
/** The band drew a countdown at its last render. */
let bandShown = false
/** The hub's switch for this mod: while it is off nothing pings, guards or logs. */
const isOn = () => isModOn(ID)
/** The band's third line, folded by its chevron; remembered across sessions. */
let detailsOpen = true

const SECONDS_FROM_MS = 5 * 60 * 1000

/** The band's countdown: whole minutes, then minutes and seconds for the last five. */
export function fmtCountdown(ms: number): string {
  if (ms >= SECONDS_FROM_MS) return `${Math.ceil(ms / 60000)}m`
  const secs = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`
}

/** Countdowns move with the clock, not with events, so an open panel or a drawn band redraws every 30 seconds, every second in the band's last five minutes. */
function scheduleRefresh($: EngineInterface, s: State) {
  if (refreshing) return
  refreshing = true
  void $.clock.now().then(now => {
    const left = s.lastRequestAt + TTL_MS - now
    const counting = bandShown && s.lastRequestAt > 0 && !s.compacted && left > 0
    const delay = !counting ? 30 * 1000 : left <= SECONDS_FROM_MS ? 1000 : Math.min(30 * 1000, left - SECONDS_FROM_MS)
    $.clock.after(delay, () => {
      refreshing = false
      if (!paneOpen && !bandShown) return
      $.ui.invalidate('ui.render')
      scheduleRefresh($, s)
    })
  })
}

/** The band's bar on the desktop: what is left of the hour, with rounded ends. */
function barSvg(fraction: number, fill: string, track: string): string {
  const w = 120
  const filled = Math.round(w * Math.min(1, Math.max(0, fraction)))
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="4" viewBox="0 0 ${w} 4">` +
    `<rect width="${w}" height="4" rx="2" fill="${track}"/>` +
    (filled > 0 ? `<rect width="${Math.max(4, filled)}" height="4" rx="2" fill="${fill}"/>` : '') + '</svg>'
}

function clockSvg(color: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="${color}" stroke-width="1.6" stroke-linecap="round">` +
    '<circle cx="8" cy="8" r="6.2"/><path d="M8 4.6V8l2.4 1.5"/></svg>'
}

/** The panel's headline state, on the same one-hour clock as the card. */
export function cacheState(s: State, now: number): 'warm' | 'cold' | 'stopped' | 'unknown' {
  if (s.stopped) return 'stopped'
  if (!s.lastRequestAt || s.compacted) return 'unknown'
  return isCold(s, now) ? 'cold' : 'warm'
}

/** /keepwarm and the panel's window buttons: the words after the command, the reply text back. */
export async function keepwarm($: EngineInterface, s: State, words: string[]): Promise<string> {
  const now = await $.clock.now()
  if (words[0] === 'off') {
    const wasAlways = s.always
    await stop($, s, null, true)
    return wasAlways ? 'keepwarm is off, and always is off for every session from its next turn' : 'keepwarm is off'
  }
  if (words[0] === 'always') {
    s.always = true
    await $.store.set(KEY_ALWAYS, true)
    await startWindow($, s, DEFAULT_WINDOW_MS, PING_AFTER_MS)
    const cold = isCold(s, now) ? `. The cache is cold now, so the first ping comes ${fmtDuration(s.every)} after the next turn` : ''
    return `keepwarm always on: every session stays warm until ${fmtDuration(DEFAULT_WINDOW_MS)} after its last turn; /keepwarm off turns it off for good${cold}`
  }
  if (!words.length) {
    await startWindow($, s, DEFAULT_WINDOW_MS, PING_AFTER_MS)
    return armedText(s, now, DEFAULT_WINDOW_MS)
  }
  if (words[0] !== 'status') {
    const window = parseDuration(words[0] ?? '')
    if (!window) return 'keepwarm takes a window such as 6h or 90m, or always, off, or status'
    // "every 2m" is a testing knob and lasts only for the window it was given with.
    let every = PING_AFTER_MS
    if (words[1] === 'every') {
      const period = parseDuration(words[2] ?? '')
      // A period of the cache's whole hour or more would fire only once the cache is already cold.
      if (period == null || period < MIN_PING_MS || period >= TTL_MS) return 'every takes a period from 1m to 59m'
      every = period
    }
    await startWindow($, s, window, every)
    const rolls = s.always && (window < DEFAULT_WINDOW_MS || every !== PING_AFTER_MS)
    return armedText(s, now, window) + (rolls ? `. Always is on, so your next turn makes it at least ${fmtDuration(DEFAULT_WINDOW_MS)} at one ping per ${fmtDuration(PING_AFTER_MS)}` : '')
  }
  return statusText(s, now) ?? 'keepwarm is off'
}

/** /cache-tax guard and the panel's guard buttons. */
export async function setGuard($: EngineInterface, s: State, mode: string | undefined): Promise<string> {
  if (mode !== 'warn' && mode !== 'refuse') return '/cache-tax guard takes warn or refuse'
  s.guard = mode
  await $.store.set(KEY_GUARD, s.guard)
  updateStatus($, s, await $.clock.now())
  return s.guard === 'refuse' ? 'guard set to refuse once: a cold send is dropped with its price, the resend goes through' : 'guard set to warn: a cold send goes through with its price shown'
}

/** The band replaces the status line once a terminal or the desktop app draws this session; returns the theme it draws in, or null when it was already seated. */
async function seatBand($: EngineInterface, s: State): Promise<{ light: boolean; noColor: boolean } | null> {
  if (s.hasBand) return null
  s.hasBand = true
  const theme = (await $.config.list()).find(row => row.key === 'theme')?.value
  const colors = { light: typeof theme === 'string' && theme.startsWith('light'), noColor: Boolean(await $.env.get('NO_COLOR')) }
  $.ui.status(undefined)
  $.ui.invalidate('ui.render')
  return colors
}

export function freshState(): State {
  return {
    hasBand: false, sid: '', deadline: 0, every: PING_AFTER_MS, always: false, lastRequestAt: 0, lastModel: null, ctx: 0, compacted: false,
    resumedAt: 0, transcript: 0, guard: 'refuse', ackedAt: 0, coldWritePending: false, misses: [], pending: null, last: null, pings: [], stopped: null,
    waitForTurn: false, retries: 0, retryReason: '', gen: 0, tick: 0, offs: 0, turnOffs: null, inFlight: false, stepWrites: null, steps: 0, endingSid: '',
  }
}


const NAME = 'Cache'

const s = freshState()
let light = false
let noColor = false

const palette = () => light
  ? { warm: '#397527', cold: '#c15f3c', waiting: '#686861', track: '#e3e2dc' }
  : { warm: '#71c362', cold: '#d97757', waiting: '#92928b', track: '#3a3a37' }

async function openPane($: EngineInterface) {
  const opened = await $.ui.open({ id: PANE, title: 'Cache Tax' })
  if (opened.isPlaced) {
    paneOpen = true
    scheduleRefresh($, s)
    // /cache-tax opens it too: the hub's button should say so.
    $.ui.invalidate('ui.render')
  }
  return opened
}

export function registerCacheTax(on: On) {
  on('config.set', { key: 'theme' }, async ($, e, next) => {
    const result = await next(e)
    if (result.deny === undefined) {
      light = typeof result.value === 'string' && result.value.startsWith('light')
      setLook({ light })
      if (s.hasBand) $.ui.invalidate('ui.render')
    }
    return result
  })

  on('command.run', { command: 'keepwarm' }, async ($, e) => {
    if (!isOn()) return { text: offText(NAME) }
    await reseat($, s)
    const words = String(e.args ?? '').trim().split(/\s+/).filter(Boolean)
    return { text: await keepwarm($, s, words) }
  })

  on('command.run', { command: 'cache-tax' }, async ($, e) => {
    if (!isOn()) return { text: offText(NAME) }
    await reseat($, s)
    const words = String(e.args ?? '').trim().split(/\s+/).filter(Boolean)
    const now = await $.clock.now()
    if (words[0] === 'guard') return { text: await setGuard($, s, words[1]) }
    if (words.length) return { text: card(s, now) }
    // Bare /cache-tax opens the panel where a surface can draw it; the text card stays the answer everywhere else.
    const opened = await openPane($)
    if (opened.isPlaced) return { text: 'cache-tax panel opened (/cache-tax status for the text card)' }
    // An unplaced pane would pop up later on its own; the card answers now instead.
    await $.ui.close({ id: PANE })
    const why = opened.reason.startsWith('no-surface') ? '' : `\n(panel not shown: ${opened.reason})`
    return { text: card(s, now) + why }
  })

  // The panel: the same state the card prints, with controls in place of commands.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const now = await $.clock.now()
    const state = cacheState(s, now)
    const accent = noColor ? undefined : state === 'warm' ? 'success' : state === 'cold' ? (light ? '#c15f3c' : '#d97757') : undefined
    const label = state === 'warm' ? 'WARM' : state === 'cold' ? 'COLD' : state === 'stopped' ? 'STOPPED' : 'UNKNOWN'
    const clock = state === 'warm' ? `${fmtDuration(s.lastRequestAt + TTL_MS - now)} until cold`
      : state === 'cold' ? `cold for ${fmtDuration(now - s.lastRequestAt - TTL_MS)}`
      : s.compacted ? 'waiting for the first turn after compaction'
      : 'waiting for the first turn'
    const press = (words: string[]) => () => { void keepwarm($, s, words).then(text => $.ui.toast(text)) }
    const guard = (mode: GuardMode) => () => { void setGuard($, s, mode).then(text => $.ui.toast(text)) }
    const windowText = s.deadline && now < s.deadline ? (statusText(s, now) ?? '').replace(/^keepwarm /, '')
      : s.stopped ? `stopped, ${s.stopped}` : 'off'
    const paid = s.misses.reduce((a, m) => a + (m.usd ?? 0), 0)
    const pings = breakEvenPings(s)
    const row = (name: string, value: string) => (
      <Box flexDirection="row"><Box width={12} flexShrink={0}><Text dimColor>{name}</Text></Box><Text>{value}</Text></Box>
    )
    const isWindow = (ms: number) => !s.always && s.deadline > now && Math.abs(s.deadline - now - ms) < 60 * 1000

    if (!isOn()) {
      return (
        <Box flexDirection="column" gap={1}>
          <Text bold>Cache is off</Text>
          <Text dimColor>Nothing pings or guards while it is off. Turn it on from the mods hub's ⚙ settings above the prompt.</Text>
        </Box>
      )
    }

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Text><Text color={accent} bold>{label}</Text><Text dimColor>  {clock}</Text></Text>
          <Text dimColor>{s.lastModel ?? 'model not seen yet'}</Text>
        </Box>
        <Box flexDirection="column">
          {row('context', `${s.ctx.toLocaleString('en-US')} tokens`)}
          {row('cold send', `${fmtUsd(coldUsd(s))} to re-write`)}
          {row('warm send', fmtUsd(warmUsd(s)))}
          {pings != null && row('break-even', `${pings} pings, about ${fmtDuration(pings * s.every)} of idle`)}
        </Box>
        <Box flexDirection="column">
          <Text bold>Keep warm</Text>
          <Text dimColor>{windowText}{s.always ? ' · always on' : ''}</Text>
          <Box flexDirection="row" gap={1} flexWrap="wrap">
            <Button key="kw-90m" label="90m" hotkey="1" variant={isWindow(90 * 60000) ? 'primary' : 'secondary'} onPress={press(['90m'])} />
            <Button key="kw-3h" label="3h" hotkey="2" variant={isWindow(3 * 3600000) ? 'primary' : 'secondary'} onPress={press(['3h'])} />
            <Button key="kw-6h" label="6h" hotkey="3" variant={isWindow(DEFAULT_WINDOW_MS) ? 'primary' : 'secondary'} onPress={press([])} />
            <Button key="kw-always" label="Always" hotkey="a" variant={s.always ? 'primary' : 'secondary'} onPress={press(['always'])} />
            <Button key="kw-off" label="Off" hotkey="o" variant="secondary" onPress={press(['off'])} />
          </Box>
        </Box>
        <Box flexDirection="column">
          <Text bold>Cold-send guard</Text>
          <Text dimColor>{s.guard === 'refuse' ? 'Drops a cold send once with its price; resend to pay it.' : 'Shows the price and sends.'}</Text>
          <Box flexDirection="row" gap={1}>
            <Button key="guard-refuse" label="Refuse once" hotkey="r" variant={s.guard === 'refuse' ? 'primary' : 'secondary'} onPress={guard('refuse')} />
            <Button key="guard-warn" label="Warn only" hotkey="w" variant={s.guard === 'warn' ? 'primary' : 'secondary'} onPress={guard('warn')} />
          </Box>
        </Box>
        <Box flexDirection="column">
          <Text bold>This session</Text>
          <Text dimColor>{s.misses.length} cold write{s.misses.length === 1 ? '' : 's'} paid, {fmtUsd(paid)}</Text>
          {s.pings.length === 0 && s.misses.length === 0 && <Text dimColor>No pings or cold writes yet.</Text>}
          {[...s.pings.map(p => ({ at: p.at, text: `ping read ${fmtTok(p.read)}, wrote ${fmtTok(p.write)} · ${fmtUsd(p.usd)}${p.warm ? '' : ' · cache was gone'}` })),
            ...s.misses.map(m => ({ at: m.at, text: `cold write ${fmtTok(m.tokens)} · ${fmtUsd(m.usd)}` }))]
            .sort((a, b) => a.at - b.at).slice(-6)
            .map(item => <Text>{fmtDuration(now - item.at)} ago  {item.text}</Text>)}
        </Box>
        <Text dimColor>Estimates from a one-hour clock, not a live server check.</Text>
      </Box>
    )
  })
}

// ---------- this mod's part of the events every mod shares (hooks/mods/index.ts chains them) ----------

export async function cacheTaxSessionStart($: EngineInterface, e: ArgOf<'session.start'>, next: NextOf<'session.start'>) {
  const r = await next(e)
  // A session the desktop app started has no surface yet: the app attaches after this, and session.attach seats the band then.
  const surfaces = [e.surface, ...await $.session.surfaces()]
  const seated = surfaces.some(x => x === 'terminal' || x === 'desktop') ? await seatBand($, s) : null
  if (seated) {
    ({ light, noColor } = seated)
    setLook(seated)
  }
  const now = await seat($, s)
  await prune($, s, now)
  const saved = await $.store.get(deadlineKey(s))
  const savedEvery = await $.store.get(everyKey(s))
  const savedGuard = await $.store.get(KEY_GUARD)
  s.deadline = typeof saved === 'number' && saved > now ? saved : 0
  s.every = typeof savedEvery === 'number' && savedEvery >= MIN_PING_MS && savedEvery < TTL_MS ? savedEvery : PING_AFTER_MS
  s.guard = savedGuard === 'warn' ? 'warn' : 'refuse'
  s.always = (await $.store.get(KEY_ALWAYS)) === true
  detailsOpen = (await $.store.get(KEY_DETAILS)) !== false
  // Always means a fresh default window every session, whatever the last one left behind.
  if (s.always) await startWindow($, s, DEFAULT_WINDOW_MS, PING_AFTER_MS)
  // The classic start arms a restored window too, but a managed plugin above this tier may continue beneath it; arming twice leaves one timer.
  else if (s.deadline) await arm($, s)
  await $.command.register({
    name: 'keepwarm',
    description: 'Keep the prompt cache warm: bare for 6h, a window such as 90m, always, off, or status (mods-hub)',
    argumentHint: '[6h | always | off | status]',
    immediate: true,
  })
  await $.command.register({
    name: 'cache-tax',
    description: 'Open the Cache Tax panel: cache state, cold price, keepwarm and guard controls; status for the text card (mods-hub)',
    argumentHint: '[status | guard warn | guard refuse]',
    immediate: true,
  })
  // The hook form of cache-tax ships a /cache-tax:status skill; both installed means two guards.
  const commands = await $.command.list()
  if (isOn() && commands.some(c => c.name === 'cache-tax:status')) {
    $.ui.log('the hook form (cache-tax@claude-code-hooks) is also installed, so a cold send is warned about or refused twice. Uninstall it, or /cache-tax guard warn here.')
  }
  updateStatus($, s, now)
  return r
}

export async function cacheTaxSessionAttach($: EngineInterface, e: ArgOf<'session.attach'>, next: NextOf<'session.attach'>) {
  const r = await next(e)
  const seated = e.surface === 'terminal' || e.surface === 'desktop' ? await seatBand($, s) : null
  if (seated) {
    ({ light, noColor } = seated)
    setLook(seated)
  }
  return r
}

// On Team and Enterprise accounts a managed plugin seated above this tier handles classic.* and continues beneath it, so
// nothing here is relied on alone: session.end carries the /clear, turn.step the compaction, and the engine's own figures
// the resumed context. What arrives here refines that, once: a clear already ended is only seated, a seat is never redone.
export async function cacheTaxSessionEnd($: EngineInterface, e: ArgOf<'session.end'>, next: NextOf<'session.end'>) {
  // Only the conversation this state sits in: after the classic start of the next one, the old id is history.
  if ((e.reason === 'clear' || e.reason === 'resume') && e.sessionId === s.sid) await endConversation($, s, e.reason)
  return next(e)
}

// Resume fields seed the guard before any turn of the resumed session has run.
export async function cacheTaxClassicSessionStart($: EngineInterface, e: ArgOf<'classic.SessionStart'>, next: NextOf<'classic.SessionStart'>) {
  const r = await next(e)
  // A resumed or cleared conversation is not the one a ping in flight was sent for.
  outdate(s)
  // The conversation moved under this state without session.end reaching it: the payload names another id, or a
  // clear names none. One that already seated the new id (a command ran first) is left as it is.
  if (s.sid && (e.session_id === undefined ? e.source === 'clear' : e.session_id !== s.sid)) await endConversation($, s, e.source === 'clear' ? 'clear' : 'resume')
  // No session.start fires after /clear, so this is where always arms the new conversation.
  await reseat($, s)
  if (e.source === 'clear') return r
  const line = seedFromResume(s, e, await $.clock.now())
  if (line && isOn()) $.ui.log(line)
  // The seeded clock decides whether a restored or always window pings before the first turn: never when it is cold.
  await arm($, s)
  return r
}

export async function cacheTaxUiClose($: EngineInterface, e: ArgOf<'ui.close'>, next: NextOf<'ui.close'>) {
  if (e.id === PANE) paneOpen = false
  return next(e)
}

// The message that pays. Only its first character is read.
export async function cacheTaxPromptSubmit($: EngineInterface, e: ArgOf<'prompt.submit'>, next: NextOf<'prompt.submit'>) {
  if (e.origin.kind === 'plugin' || !isOn()) return next(e)
  await reseat($, s)
  if (typeof e.text !== 'string' || e.text.trimStart().startsWith('/')) return next(e)
  const now = await $.clock.now()
  // Without the time of the last response nothing says whether the cache is cold: the price is shown once and the message goes through.
  if (s.resumedAt) {
    const cold = mayBeCold(s, now)
    s.resumedAt = 0
    if (cold && s.ctx >= BIG_TOKENS) $.ui.log(unknownText(s))
    return next(e)
  }
  if (!isCold(s, now) || s.ctx < BIG_TOKENS) return next(e)
  // A refused prompt that no person sent would be lost: nobody is there to send it again.
  const unattended = UNATTENDED.has(e.origin.kind)
  if (s.guard === 'warn' || unattended) {
    $.ui.log(`${guardText(s, now)} Sending anyway${unattended ? `, since this ${e.origin.kind} prompt cannot be sent again` : ''}; keepwarm will hold the cache for ${fmtDuration(holdMs(s))} once it lands.`)
    s.coldWritePending = true
    return next(e)
  }
  if (s.ackedAt === s.lastRequestAt) {
    s.ackedAt = 0
    s.coldWritePending = true
    return next(e)
  }
  s.ackedAt = s.lastRequestAt
  return { drop: `cache-tax: ${guardText(s, now)} Send it again to pay it, and keepwarm will then hold the cache for ${fmtDuration(holdMs(s))}. Or /clear and start from a note.` }
}

// The clock and the context are tracked while the mod is off too, so turning it back on shows the truth at once.
export async function* cacheTaxTurnStep($: EngineInterface, e: ArgOf<'turn.step'>, next: NextOf<'turn.step'>) {
  if (!e.agentId) {
    await reseat($, s)
    // The off count when the turn's first request went out: an off after it wins over what the turn opens.
    if (e.index === 0) s.turnOffs = s.offs
    // A compaction leaves a summary where tens of messages were; a rewind takes a few off. A request over fewer than half the
    // last one's messages is read as a compaction, whether or not session.compact arrived. The context stays as it was, so
    // turn.complete still scores a cold write this turn paid against it before the live figure replaces it.
    if (e.messageCount * 2 < s.transcript) markCompacted(s)
    s.transcript = e.messageCount
    // Only a request sent before any compaction this turn saw can hold a cold write; what follows one is the summary.
    if (!s.compacted) s.steps++
    s.lastRequestAt = await $.clock.now()
  }
  const r = yield* next(e)
  // Each request's write is priced at its own prompt length's tier (Haiku 5.5 changes price at 100k), not the turn's sum.
  const u = r.usage
  if (!e.agentId && u && !s.compacted) {
    const price = priceOf(u.model || e.model, u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens)
    const was = s.stepWrites ?? { tokens: 0, usd: 0, priced: true }
    s.stepWrites = { tokens: was.tokens + u.cache_creation_input_tokens, usd: was.usd + (price ? u.cache_creation_input_tokens * price[1] / 1e6 : 0), priced: was.priced && price != null }
  }
  return r
}

export async function cacheTaxTurnComplete($: EngineInterface, e: ArgOf<'turn.complete'>, next: NextOf<'turn.complete'>) {
  const r = await next(e)
  if (e.agentId) return r
  // An off at any point in this turn wins over every window the turn would open; a host that raised no
  // step falls back to the count at completion.
  const offs = s.turnOffs ?? s.offs
  s.turnOffs = null
  const now = await $.clock.now()
  // A sleeping host may deliver this turn before the expired window's timer.
  if (s.deadline && now >= s.deadline) await stop($, s, null)
  // turn.step stamps the exact request time; when no step of this turn did, the turn's end is the floor.
  // A turn aborted before it sent anything touched no cache, so it leaves the clock alone.
  if ((e.usage || !e.isAborted) && now - s.lastRequestAt > e.durationMs) s.lastRequestAt = now
  const compacted = s.compacted
  s.compacted = false
  if (s.lastRequestAt) s.resumedAt = 0
  s.waitForTurn = false
  s.ackedAt = 0
  // Always covers any break up to six hours after a turn that reached the cache (a turn that failed before any
  // response touched nothing, and its cache may be cold): a window of at least six hours at the default period,
  // which brings back a stopped window and replaces a shorter one or a testing period. Another session's
  // /keepwarm off or /keepwarm always changes the shared switch, so every such turn reads it.
  if (e.usage && isOn()) {
    const shared = (await $.store.get(KEY_ALWAYS)) === true
    if (s.offs === offs) s.always = shared
    if (s.always) await startWindow($, s, Math.max(DEFAULT_WINDOW_MS, s.deadline - now), PING_AFTER_MS, offs)
  }
  const u = e.usage
  if (u) {
    if (u.model) s.lastModel = u.model
    const prev = s.ctx
    // A turn's usage is its responses summed, so a ten-step turn reports ten
    // reads of the context. The live window is the engine's figure; the sum
    // is only the fallback for a host that reports no tokens.
    const written = u.cache_creation_input_tokens
    const live = (await $.session.usage()).context.tokens
    s.ctx = live && live > 0 ? live : u.input_tokens + u.cache_read_input_tokens + written
    // A compaction since the last complete turn: what followed it is the summary, no cold write, so the turn is scored
    // on the requests before it alone. None before it leaves nothing to score, whatever the guard saw; requests before
    // it that reported no usage leave only the turn's total, an upper bound kept for a send the guard saw go cold.
    const writes = s.stepWrites
    const write = !compacted ? written : writes ? writes.tokens : s.steps && s.coldWritePending ? written : 0
    const full = prev > 20000 && write >= 0.5 * prev
    if (isOn() && (full || (s.coldWritePending && write > 0))) {
      // Priced per request when the steps reported usage; otherwise at the tier of the context the comeback re-sent.
      const price = priceOf(s.lastModel, prev || s.ctx)
      const usd = writes?.priced ? writes.usd : price ? write * price[1] / 1e6 : null
      s.misses.push({ at: now, tokens: write, usd })
      const extend = s.deadline < now + AUTO_WARM_MS && s.offs === offs
      if (extend) await startWindow($, s, AUTO_WARM_MS, s.every, offs)
      $.ui.log(`cold write of ${fmtTok(write)} tokens paid (${fmtUsd(usd)}).` +
        (extend ? ` Keeping the cache warm for ${fmtDuration(AUTO_WARM_MS)} so it is not paid again today; /keepwarm off to stop.` : ''))
    }
  }
  s.coldWritePending = false
  s.stepWrites = null
  s.steps = 0
  await arm($, s)
  // The hub's countdown restarts with every turn, armed or not.
  if (s.hasBand) $.ui.invalidate('ui.render')
  return r
}

export async function cacheTaxSessionCompact($: EngineInterface, e: ArgOf<'session.compact'>, next: NextOf<'session.compact'>) {
  const r = await next(e)
  if (!e.agentId) {
    markCompacted(s)
    // Between turns nothing is left to score, and the next turn's summary write is not a cold write.
    s.ctx = 0
    disarm(s)
    await arm($, s)
  }
  return r
}

export const cacheTax: Mod = {
  id: ID,
  name: NAME,
  icon: '◷',
  pane: { id: PANE },
  description: 'Keeps the one-hour prompt cache warm during breaks and stops a cold send once with its price.',
}

// The badge runs on every hub draw, so it also keeps the countdown moving while another tab is selected.
export async function cacheTaxBadge($: EngineInterface, e: BandInput): Promise<Badge | null> {
  const now = await $.clock.now()
  const known = s.lastRequestAt > 0 && !s.compacted
  bandShown = known || s.deadline > now || s.stopped !== null
  if (bandShown) scheduleRefresh($, s)
  if (s.stopped) return { glyph: '!', color: noColor ? undefined : palette().cold, label: 'keepwarm stopped' }
  if (!known) return null
  if (isCold(s, now)) return { glyph: '●', color: noColor ? undefined : palette().cold, label: 'cache cold' }
  if (s.lastRequestAt + TTL_MS - now <= SECONDS_FROM_MS) return { glyph: '●', color: noColor ? undefined : '#E0A800', label: 'cache going cold soon' }
  return null
}

// The countdown and its bar as the headline, Keep Warm beside it, and the price of a reply now under both.
export async function cacheTaxView($: EngineInterface, e: BandInput): Promise<ModView> {
  const now = await $.clock.now()
  const known = s.lastRequestAt > 0 && !s.compacted
  const armed = s.deadline > now
  const state = !known ? 'waiting' : isCold(s, now) ? 'cold' : 'warm'
  const left = s.lastRequestAt + TTL_MS - now
  const colors = palette()
  const hub = hubColors()
  const color = noColor ? undefined : state === 'warm' ? colors.warm : state === 'cold' ? colors.cold : undefined
  const els = $.ui.resolve(e)
  const { Box, Text, Button } = els
  const Svg = e.surface === 'desktop' && !noColor && 'Svg' in els ? els.Svg : undefined
  const Image = e.surface === 'terminal' && !noColor && 'Image' in els ? els.Image : undefined

  const toast = (words: string[]) => () => { void keepwarm($, s, words).then(text => $.ui.toast(text)) }
  const keepWarm = armed
    ? <Button key="band-keepwarm" label={`Keeping Warm · ${fmtDuration(s.deadline - now)}`} hotkey={e.surface === 'desktop' ? undefined : 'k'} variant="primary" onPress={toast(['off'])} />
    : <Button key="band-keepwarm" label="Keep Warm" hotkey={e.surface === 'desktop' ? undefined : 'k'} variant="secondary" onPress={toast([])} />

  const asset = state === 'waiting' ? null : statusIcons[light ? 'light' : 'dark'][state]
  const icon = Svg ? <Svg source={clockSvg(colors[state])} width={16} height={16} alt="Cache clock" />
    : Image && asset ? <Image source={{ png: asset.png }} columns={3} rows={1} alt="[>]" />
    : <Text color={color} bold>[&gt;]</Text>

  if (state === 'waiting') {
    const why = s.stopped ? `Keepwarm stopped: ${s.stopped}.` : s.compacted ? 'Compacted: the hour starts again with the next reply.' : 'The hour starts when the first reply lands.'
    return {
      headline: (
        <Box flexDirection="row" alignItems="center" gap={1}>
          <Box flexShrink={0}>{icon}</Box>
          <Box flexShrink={1}><Text color={hub.muted} dimColor={!hub.muted}>{why}</Text></Box>
        </Box>
      ),
      actions: [keepWarm],
      rows: [],
    }
  }

  const fraction = state === 'warm' ? left / TTL_MS : 0
  const cells = 12
  const filled = Math.round(cells * fraction)
  const bar = Svg ? <Svg source={barSvg(fraction, colors[state], colors.track)} width={120} height={4} alt={`${Math.round(fraction * 100)}% of the hour left`} />
    : <Text><Text color={color}>{'━'.repeat(filled)}</Text><Text dimColor>{'━'.repeat(cells - filled)}</Text></Text>

  const title = state === 'warm' ? 'Cache Warm' : 'Cache Cold'
  const time = state === 'warm' ? fmtCountdown(left) : `for ${fmtDuration(now - s.lastRequestAt - TTL_MS)}`
  const tokens = `${fmtTok(s.ctx)} tokens`
  const warm = warmUsd(s)
  const cold = coldUsd(s)
  const priced = warm != null && cold != null && s.ctx > 0
  const summary = state === 'warm'
    ? `Reply now and ${priced ? `${tokens} are read for ${fmtUsd(warm)} instead of re-written for ${fmtUsd(cold)}` : 'the chat is read from cache, not re-written'}.`
    : `Your next message re-writes ${priced ? `${tokens} for ${fmtUsd(cold)}` : 'the whole chat'}${s.guard === 'refuse' ? ', and is held once so you can decide' : ''}.`
  const stopped = s.stopped ? ` Keepwarm stopped: ${s.stopped}.` : ''
  const pings = breakEvenPings(s)
  const details = '1 hour cache, counted from the last reply. Each ping reads the chat from cache for a small part of the price; letting it go cold means writing it all again.' +
    (pings != null ? ` Up to ${pings} pings cost the same as one cold write.` : '')
  const toggle = () => {
    detailsOpen = !detailsOpen
    void $.store.set(KEY_DETAILS, detailsOpen)
    $.ui.invalidate('ui.render')
  }
  // The details' chevron ends the last line shown.
  const chevron = <Button key="band-details" label={detailsOpen ? '⌃' : '⌄'} variant="secondary" dimColor onPress={toggle} />
  const line = (text: Row, withChevron: boolean) => (
    <Box flexDirection="row" alignItems="flex-end" justifyContent="space-between" gap={1}>
      <Box flexShrink={1}>{text}</Box>
      {withChevron && <Box flexShrink={0}>{chevron}</Box>}
    </Box>
  )

  const rows: Row[] = [line(<Text color={hub.text}>{`${summary}${stopped}`}</Text>, !detailsOpen)]
  if (detailsOpen) rows.push(line(<Text color={hub.muted} dimColor={!hub.muted}>{details}</Text>, true))
  return {
    headline: (
      <Box flexDirection="row" alignItems="center" gap={1}>
        <Box flexShrink={0}>{icon}</Box>
        <Text color={color}>{title}</Text>
        <Text color={state === 'warm' ? color : hub.muted} dimColor={state !== 'warm' && !hub.muted}>{time}</Text>
        <Box flexShrink={0}>{bar}</Box>
      </Box>
    ),
    actions: [keepWarm],
    rows,
  }
}

export async function cacheTaxClosePane($: EngineInterface): Promise<void> {
  paneOpen = false
  await $.ui.close({ id: PANE })
}

export async function cacheTaxOpenPane($: EngineInterface): Promise<void> {
  await openPane($)
}

export async function cacheTaxEnable($: EngineInterface): Promise<void> {
  await arm($, s)
  updateStatus($, s, await $.clock.now())
}

export async function cacheTaxDisable($: EngineInterface): Promise<void> {
  outdate(s)
  disarm(s)
  updateStatus($, s, await $.clock.now())
}
