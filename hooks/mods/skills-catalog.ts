// The hand-written cards behind the Skills tab. The skills' own descriptions are
// often just a trigger ("use when the user says council"), so what each is for,
// how it works and what it needs is written here, from reading each SKILL.md.

export type AuthorId = 'theo' | 'poteto' | 'matt'
export type StageId = 'shape' | 'plan' | 'build' | 'review' | 'ship' | 'reflect'

export type Skill = {
  /** The skill's own name, as its SKILL.md gives it. */
  id: string
  /** What the row and the card call it. */
  name: string
  author: AuthorId
  stage: StageId
  /** One short line for a row. */
  line: string
  when: string
  how: string
  /** What it needs before it can do its job. */
  needs?: string
  /** Runs at once on Run. Everything else lands in the prompt box for you to add context and send. */
  fire?: boolean
  /** Left out of Install Recommended Skills, because it can't run without something more. */
  extra?: boolean
  /** Installed so it runs only when asked, never on the model's own initiative. */
  onDemand?: boolean
}

export type Author = {
  /** The short name on the panel's filter. */
  name: string
  /** Who made it, in full, on the skill's card. */
  credit: string
  /** The plugin that namespaces this author's skills, when they come as one. */
  plugin?: string
  /** How to get a skill by hand. */
  install: string
  /** Where Install Recommended Skills gets them, at a commit the hub was tested with. */
  repo: string
  commit: string
  /** Copied as skills from this path. Without it, the repository is installed as a plugin. */
  path?: string
  /** The marketplace the repository declares, for a plugin. */
  marketplace?: string
  /** Skills that aren't in the catalog but that the catalog's skills call on. */
  support?: string[]
}

export const AUTHORS: Record<AuthorId, Author> = {
  theo: {
    name: 'Theo',
    credit: 'Theo Browne',
    install: 'Copy it from github.com/t3dotgg/tstack (skills/) into ~/.claude/skills',
    repo: 't3dotgg/tstack',
    commit: '1085050f3baed1ac724caa4a8166145fb2ac88af',
    path: 'skills',
    support: ['leaving-pr-comments'],
  },
  poteto: {
    name: 'Poteto',
    credit: 'Lauren Tan (poteto), ported to Claude Code by Michael Denyer',
    install: 'Copy it from github.com/michael-denyer/pstack-claude (plugins/pstack/skills/) into ~/.claude/skills',
    repo: 'michael-denyer/pstack-claude',
    commit: 'd88063f3355a5ecff0e6dbb890a11bab4b08bc2e',
    path: 'plugins/pstack/skills',
    support: ['in-your-own-words'],
  },
  matt: {
    name: 'Matt',
    credit: 'Matt Pocock',
    plugin: 'mattpocock-skills',
    install: 'claude plugin marketplace add anthropics/claude-plugins-official, then claude plugin install mattpocock-skills@claude-plugins-official',
    repo: 'mattpocock/skills',
    commit: '4ae2317ddb22b046e26455e4f9c9b3aaaf62212d',
    marketplace: 'mattpocock',
  },
}

export const STAGES: { id: StageId; name: string; hint: string }[] = [
  { id: 'shape', name: 'Shape', hint: 'understand the problem, sharpen the idea' },
  { id: 'plan', name: 'Plan', hint: 'turn the thinking into specs and tickets' },
  { id: 'build', name: 'Build', hint: 'write the code' },
  { id: 'review', name: 'Review', hint: 'find what is wrong before it ships' },
  { id: 'ship', name: 'Ship', hint: 'get it through a pull request' },
  { id: 'reflect', name: 'Reflect', hint: 'carry what you learned forward' },
]

const TRACKER = 'Run Setup Matt Skills once in this repo first, so it knows your issue tracker.'
const SOL = 'GPT Sol. Claude Code alone cannot run it, so this stops and reports the blocker until you add a way to reach it.'

export const SKILLS: Skill[] = [
  // ---------- Shape ----------
  {
    id: 'grill-with-docs',
    name: 'Grill with Docs',
    author: 'matt',
    stage: 'shape',
    line: 'stress-test a plan and record the decisions',
    when: 'Start here for a new idea in a repo. It finds the gaps while changing course is still cheap.',
    how: 'Interviews you in rounds, each question with a recommended answer, until no branch is left open. Updates GLOSSARY.md and decision records as it goes.',
    needs: 'A repo to write those docs into. Otherwise use Grill Me. Stay in one session through To Tickets.',
  },
  {
    id: 'grill-me',
    name: 'Grill Me',
    author: 'matt',
    stage: 'shape',
    line: 'the same interview, leaving no files behind',
    when: 'Stress-testing a plan or decision with no repo to document in, including non-code decisions.',
    how: 'Interviews you in rounds, each question with a recommended answer, until nothing is silently assumed. Waits for your confirmation before acting.',
  },
  {
    id: 'sharpen',
    name: 'Sharpen',
    author: 'poteto',
    stage: 'shape',
    line: 'make a task deeper, not bigger',
    when: 'Your prompt feels fine but shallow, before you hand over something that matters.',
    how: 'Names what a top professional would do, what raw material they start from and what proves it right, then rewrites your prompt. Leaves your choices open.',
  },
  {
    id: 'how',
    name: 'How',
    author: 'poteto',
    stage: 'shape',
    line: 'explain how a subsystem works',
    when: 'Before changing code you do not know, or when asking where something should live.',
    how: 'Sends read-only explorers over the code, then one explainer writes it up: overview, key concepts, flow, where things live, gotchas.',
    onDemand: true,
  },
  {
    id: 'why',
    name: 'Why',
    author: 'poteto',
    stage: 'shape',
    line: 'find out why the code is this shape',
    when: 'Before undoing something odd, and for regressions, postmortems and design rationale.',
    how: 'Investigates git history and each connected tool in parallel, then returns a cited answer that says what is known and what is inferred.',
    needs: 'Works best with your issue tracker, chat and docs connected.',
    onDemand: true,
  },
  {
    id: 'ask-matt',
    name: 'Ask Matt',
    author: 'matt',
    stage: 'shape',
    line: 'not sure which skill fits? ask',
    when: 'You know the situation but not which of Matt\'s skills or flows suits it.',
    how: 'A router: reads the relevant skills and points you along his idea-to-ship flow or to a standalone skill.',
  },

  // ---------- Plan ----------
  {
    id: 'to-spec',
    name: 'To Spec',
    author: 'matt',
    stage: 'plan',
    line: 'turn this conversation into a spec',
    when: 'Right after grilling, once the thinking is settled and the build will span sessions.',
    how: 'No interview: it synthesizes what was discussed, checks the test seams with you, then publishes the spec to your issue tracker.',
    needs: TRACKER,
  },
  {
    id: 'to-tickets',
    name: 'To Tickets',
    author: 'matt',
    stage: 'plan',
    line: 'split a spec into small tickets',
    when: 'You have a spec or plan and want work a fresh session can pick up one piece at a time.',
    how: 'Cuts thin end-to-end slices, each one verifiable alone, states what blocks what, and publishes them to your tracker.',
    needs: `${TRACKER} Run it before clearing context.`,
  },
  {
    id: 'wayfinder',
    name: 'Wayfinder',
    author: 'matt',
    stage: 'plan',
    line: 'chart work too big for one session',
    when: 'A loose, foggy idea far too large for a single session or spec.',
    how: 'Builds a shared map of decision tickets on your tracker and resolves them one at a time. It produces decisions, not code.',
    needs: TRACKER,
  },
  {
    id: 'setup-matt-pocock-skills',
    name: 'Setup Matt Skills',
    author: 'matt',
    stage: 'plan',
    line: 'once per repo, before his planning skills',
    when: 'The first time you use To Spec, To Tickets, Wayfinder or Implement in a repo.',
    how: 'Looks over the repo, asks about your issue tracker, labels and doc layout, confirms, then writes the config.',
  },

  // ---------- Build ----------
  {
    id: 'implement',
    name: 'Implement',
    author: 'matt',
    stage: 'build',
    line: 'build one spec or ticket',
    when: 'Working through tickets one at a time. Clear context between tickets.',
    how: 'Fetches the ticket, builds test-first, runs types and tests, reviews its own work, then commits to the current branch.',
    needs: 'Say which ticket or spec. It commits without asking.',
  },
  {
    id: 'implement-spec',
    name: 'Implement Spec',
    author: 'matt',
    stage: 'build',
    line: 'build a whole spec in one run',
    when: 'You would rather orchestrate the full build than drive each ticket yourself.',
    how: 'Reads the tickets as a task graph, runs parallel subagents on what is ready, and lands it all on one integration branch.',
    needs: 'A spec and tickets from To Spec and To Tickets.',
  },
  {
    id: 'tdd',
    name: 'TDD',
    author: 'matt',
    stage: 'build',
    line: 'test first, one slice at a time',
    when: 'Building a concrete behavior or fixing a bug when you do not need a full spec.',
    how: 'Red, green, refactor, one vertical slice at a time.',
  },
  {
    id: 'diagnosing-bugs',
    name: 'Diagnosing Bugs',
    author: 'matt',
    stage: 'build',
    line: 'a disciplined loop for hard bugs',
    when: 'Something is broken, flaky or slow and the first obvious fix did not hold.',
    how: 'Runs a gated diagnosis loop, so a fix follows a proven cause instead of a guess.',
  },
  {
    id: 'prototype',
    name: 'Prototype',
    author: 'matt',
    stage: 'build',
    line: 'throwaway code to answer a question',
    when: 'A question cannot be settled by talking: state, logic, or a UI you have to see.',
    how: 'Builds a disposable prototype that answers the question. Bring back what you learned, not the code.',
  },
  {
    id: 'arena',
    name: 'Arena',
    author: 'poteto',
    stage: 'build',
    line: 'several attempts, graft the best into one',
    when: 'One attempt at something important would lock in the wrong shape.',
    how: 'Runs parallel candidates on Opus, Fable and Sonnet against a rubric, has another model family judge, picks a base and grafts in the best parts.',
    needs: 'Costs several full attempts in tokens.',
  },

  // ---------- Review ----------
  {
    id: 'council',
    name: 'Council',
    author: 'theo',
    stage: 'review',
    line: 'three models review until they agree',
    when: 'Before merging or deciding anything important. Use it for a second, third and fourth opinion.',
    how: 'Three read-only reviewers score the work out of 10. Claude fixes what it agrees with, then asks for a fresh round, keeping scope tight, until all are satisfied.',
    needs: 'Three members. It stops and reports rather than swapping in a member it cannot reach.',
  },
  {
    id: 'interrogate',
    name: 'Interrogate',
    author: 'poteto',
    stage: 'review',
    line: 'adversaries try to break the change',
    when: 'You want bugs proven, not opinions. A good fit for risky diffs and designs.',
    how: 'Opus, Fable, Sonnet and Haiku adversaries each try to break it in a worktree. Only findings proven by a run survive. It reports and does not fix.',
    needs: 'Costs four subagents in tokens.',
  },
  {
    id: 'thermo-nuclear-review',
    name: 'Thermonuclear',
    author: 'poteto',
    stage: 'review',
    line: 'deep security and correctness audit',
    when: 'A branch touches something you cannot afford to get wrong.',
    how: 'Audits only added or changed code for bugs, breakage, security holes, dev-setup regressions and feature-gate leaks, then checks any PR discussion.',
    needs: 'A checked-out branch with changes.',
  },
  {
    id: 'blast-radius',
    name: 'Blast Radius',
    author: 'poteto',
    stage: 'review',
    line: 'what else could this change break?',
    when: 'A small diff you do not trust, or a brief that assumes something about existing code.',
    how: 'Finds the one fact the change is safe because of and proves it by running real code, then lists risks and what it cleared.',
  },
  {
    id: 'code-review',
    name: 'Code Review',
    author: 'matt',
    stage: 'review',
    line: 'check a diff against standards and spec',
    when: 'Reviewing a branch or PR against what the repo documents and what the ticket asked for.',
    how: 'Two parallel subagents review the changes since a fixed point, one for standards and one for spec, and report side by side.',
  },
  {
    id: 'sol-loop',
    name: 'Sol Loop',
    author: 'theo',
    stage: 'review',
    line: 'GPT Sol reviews in a loop',
    when: 'A second provider\'s review of a change, with less ceremony than Council.',
    how: 'Up to three rounds: Sol reviews, Claude answers each finding with a minimal fix or a reasoned no, and they stop when both agree.',
    needs: SOL,
    extra: true,
  },

  // ---------- Ship ----------
  {
    id: 'full-stop',
    name: 'Full Stop',
    author: 'theo',
    stage: 'ship',
    line: 'take a change to a ready PR, unmerged',
    when: 'You are stepping away and want a PR waiting for your decision.',
    how: 'Proves the change, gets review, files the PR and babysits it until it is ready. It never merges. It may force-push this branch with a lease.',
    needs: SOL,
    extra: true,
  },
  {
    id: 'full-send',
    name: 'Full Send',
    author: 'theo',
    stage: 'ship',
    line: 'take a change all the way to merged',
    when: 'You are not watching and are happy for it to merge once its gate passes.',
    how: 'The Full Stop workflow, then it merges by itself. Saying it also overrides any ask-first testing rules for this task. Use it deliberately.',
    needs: SOL,
    extra: true,
  },
  {
    id: 'file-pr',
    name: 'File PR',
    author: 'theo',
    stage: 'ship',
    line: 'a short PR that leads with the problem',
    when: 'The change is ready and you want it filed well.',
    how: 'Checks for an existing PR, reviews the diff, follows the repo\'s title style and opens with the problem, not a list of changes.',
    needs: 'The GitHub CLI, signed in.',
  },
  {
    id: 'babysit-pr',
    name: 'Babysit PR',
    author: 'theo',
    stage: 'ship',
    line: 'watch CI and review bots, fix what is real',
    when: 'A PR is open and you do not want to keep checking it.',
    how: 'Watches for events, verifies each bot finding, fixes the real ones and replies with reasons to the rest. It only merges if you asked it to.',
    needs: 'The GitHub CLI and python3.',
  },
  {
    id: 'modernize',
    name: 'Modernize',
    author: 'theo',
    stage: 'ship',
    line: 'revive an old PR, or decide to close it',
    when: 'An old PR has drifted. It asks whether the PR should still exist, not just whether it rebases.',
    how: 'Studies its intent and what changed since, then recommends modernize, rework or close. It rebases and pushes only for modernize, and never merges.',
    needs: 'The PR number. The GitHub CLI, signed in.',
  },
  {
    id: 'takeover',
    name: 'Takeover',
    author: 'theo',
    stage: 'ship',
    line: 'finish someone else\'s PR, keep their credit',
    when: 'Another person or agent left a PR, branch or thread unfinished.',
    how: 'Reads the source and its review history, imports the commits with authorship intact, adds fixes separately, and verifies independently.',
    needs: 'The PR, branch or thread to take over.',
  },

  // ---------- Reflect ----------
  {
    id: 'retro',
    name: 'Retro',
    author: 'matt',
    stage: 'reflect',
    line: 'improve your setup after a session',
    when: 'After a build, especially one that went sideways. Run it before clearing context.',
    how: 'Reads the session and suggests changes to the agent\'s environment, most severe first: checks, standards, steering files. Not code changes.',
    fire: true,
  },
  {
    id: 'handoff',
    name: 'Handoff',
    author: 'matt',
    stage: 'reflect',
    line: 'pass this work to a fresh session',
    when: 'The session is getting long, or the work is moving to another directory.',
    how: 'Writes a compact document to a temp folder, linking to specs and commits rather than repeating them. Add what the next session is for.',
  },
]

/** What Install Recommended Skills sets up: everything that can run without more setup than a sign-in. */
export const RECOMMENDED = SKILLS.filter(s => !s.extra)

export const DEFAULT_FAVORITES = ['council', 'grill-with-docs', 'to-spec', 'to-tickets', 'retro']

/** The members Council can be given, in the order the card lists them. */
export const COUNCIL_OPTIONS: { name: string; provider: 'anthropic' | 'openai' | 'google' }[] = [
  { name: 'Claude Opus', provider: 'anthropic' },
  { name: 'Claude Fable', provider: 'anthropic' },
  { name: 'Claude Sonnet', provider: 'anthropic' },
  { name: 'GPT Sol', provider: 'openai' },
  { name: 'Gemini Pro', provider: 'google' },
]

export const COUNCIL_SEATS = 3
export const DEFAULT_MEMBERS = ['Claude Opus', 'Claude Fable', 'Claude Sonnet']
