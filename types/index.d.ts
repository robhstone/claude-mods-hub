// ---------- the hub ----------

/** What the hub's body shows: the selected mod, the ⋯ list of every mod, or the settings. */
export type HubView = 'tabs' | 'menu' | 'settings'

// ---------- Progress (crew) ----------

export type StepStatus = 'pending' | 'in_progress' | 'completed'

export type PlanItem = { id: string; label: string; status: StepStatus }

export type Step = {
  id: string
  label: string
  tool: string
  startedAt: number
  endedAt?: number
  // Tokens of new work: input, output and what was written to the cache.
  tokens: number
  // Tokens re-read from the prompt cache, which cost far less.
  cached: number
  // Tokens weighted by what each kind costs, to share usage out by.
  work: number
}

export type AgentStatus = 'running' | 'done' | 'stopped' | 'failed'

export type Agent = {
  id: string
  name: string
  type: string
  model: string
  purpose: string
  brief: string
  color: number
  planItemId?: string
  status: AgentStatus
  startedAt: number
  endedAt?: number
  tokens: number
  cached: number
  work: number
  wrapRequested?: boolean
  steps: Step[]
}

export type Run = {
  id: string
  prompt: string
  startedAt: number
  endedAt?: number
  startCostUsd?: number
  startFiveHour?: number
  // Every loop's weighted tokens this request, main Claude's included.
  work: number
  agents: Agent[]
}

export type Usage = { costUsd?: number; fiveHour?: number; sevenDay?: number }

declare module 'claude-code' {
  interface PluginState {
    'mods-hub': {
      // The hub: which body shows, and which mod's tab is selected (a non-favorite one shows as a tab of its own).
      view: HubView
      selected: string
      favorites: string[]
      enabled: Record<string, boolean>
      folded: boolean
      // The first body row shown, when the body is taller than the hub allows.
      offset: number
      // Progress
      crewRuns: Shaped<Run[]>
      crewPlan: Shaped<PlanItem[]>
      crewUsage: Usage
      crewNow: number
    }
  }
}
