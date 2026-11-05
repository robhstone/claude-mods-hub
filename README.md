# Mods Hub

A home base above the prompt for all your Claude Code mods. Every mod lives in one band: your favorites each get a tab, the rest sit under ⋯, and ⚙ turns any of them on or off.

It ships with three mods:

- **◷ Cache**: keeps the one-hour prompt cache warm during breaks and stops a cold send once with its estimated price. Based on [karanb192/cache-tax](https://github.com/karanb192/cache-tax) (MIT), by way of cache-tax-gui. Warming uses model requests and costs tokens.
- **▤ Progress**: Claude's plan and what each sub-agent is doing, why, and how far along it is (formerly crew).
- **✦ Skills**: your favorite skills one press away, and a library of when and how to use each one. It covers [Theo Browne's tstack](https://github.com/t3dotgg/tstack), [Lauren Tan's pstack](https://github.com/cursor/plugins/tree/main/pstack) in [Michael Denyer's Claude Code port](https://github.com/michael-denyer/pstack-claude), and [Matt Pocock's skills](https://github.com/mattpocock/skills). One button installs them, and anything else you already have shows up too.

## The hub

In the terminal and the Desktop app's Code tab, the hub sits above the prompt, in the frame the app draws there. The selected mod fills the top; a darker bar along the bottom switches between mods:

- **The top**: the mod's headline on the left (Cache's countdown and bar, Progress's plan), its actions on the right (**Open Panel** (p) for a mod with a side pane, which reads **Close Panel** and closes it while it's open, then the mod's own, such as **Keep Warm** (k)), and its rows underneath.
- **Tabs**, on the bar's left: up to 4 favorites, in the order you starred them, with hotkeys 1–4. The selected one is underlined. A tab you aren't on gets a dot when something happens: ● in orange when the cache goes cold, ●2 in green while two sub-agents work. The hub never switches tabs by itself.
- **More ⋯** (m) lists every mod. Picking one that isn't a favorite shows it under a tab of its own until you pick another. A mod that's off shows dimmed, with Turn on.
- **⚙** (s), or `/mods`, shows each mod with **On/Off** and **★**. A mod that's off stops completely: no keep-warm pings, no cold-send guard, no sub-agent tracking.
- **▾** (f) collapses the hub to the mod's headline, its actions and the bar; the hub remembers that.

A mod shows 5 rows at most. Anything longer scrolls with the wheel or the ↑ ↓ that appear under it. The letters in brackets are terminal hotkeys, which work once the hub has focus (ctrl+x tab); the desktop leaves them off so its buttons draw no key chips.

Favorites, on/off switches, the selected tab and the collapse all carry over to your next session.

## Skills

The tab shows your favorites as chips, each slot with its own color. Picking one shows its card (when to use it, how it works, what it needs), with its **Run** in the header. **All Skills** (p) opens the full library in a side panel, grouped by stage of work and filterable by author, where ★ adds or removes a favorite; while it's open the button reads **Close Panel**. Add a skill to `hooks/mods/skills-catalog.ts` to give it a card.

**Run** puts the command in your prompt box, keeping anything you already typed, so you can add context and send. Retro needs no context, so it starts right away. In the panel, pressing a row runs that skill and ⓘ opens its card.

Council's card has a member picker. Your three picks go in the prompt, which Council follows. The default is three Claude models, because Claude Code can't reach other providers by itself: tick GPT Sol or Gemini Pro once you have a way to run them. Without one, Council reports the gap rather than swapping in another member. Full Send, Full Stop and Sol Loop need GPT Sol for the same reason.

### Installing the skills

The hub doesn't include the skills themselves. If any recommended ones are missing, the Skills tab shows **Install Recommended Skills**: press it once. It needs only an internet connection, not git, the GitHub CLI or a GitHub account.

- **What you get:** every skill in the library except Full Send, Full Stop and Sol Loop, which can't run without GPT Sol. Some installed skills do their real work through other tools, and each card's Needs line says so, such as the GitHub CLI for File PR.
- **Where they come from:** each author's own repository, at a commit the hub was tested with (listed in `hooks/mods/skills-catalog.ts`). Their licenses go with them.
- **Where they go:** Theo's and pstack's into `~/.claude/skills`, and Matt's as a plugin kept in `~/.claude/mods-hub`.
- **What it leaves alone:** a skill you already have is never replaced, so your edits are safe. How and Why are set to run only when you ask.

If something doesn't show up right away, start a new session. The installer needs a Mac or Linux shell. On Windows, follow each author's own install steps, linked under [Thanks](#thanks).

### Skills you already have

The panel's **Existing** filter lists every other skill you have, from `~/.claude/skills` or a plugin, grouped by where it came from. Pressing a row runs it, ⓘ shows its description, and ★ makes it a favorite like any other.

## Commands

- `/mods`: open the hub's settings
- `/skill-deck`: open the skills library
- `/cache-tax`: the Cache Tax pane. `/cache-tax status` gives a text card, and `/cache-tax guard warn|refuse` sets the guard.
- `/keepwarm`, `/keepwarm 90m`, `/keepwarm always`, `/keepwarm off`, `/keepwarm status`

## Adding a mod

The engine lets `$` reach only functions declared at the top level of a file, and a plugin may hook each event once without a matcher. So a mod is a small description plus top-level functions, and `hooks/mods/index.ts` wires them up. Use `hooks/mods/crew.tsx` as a model:

1. **Write `hooks/mods/<name>.tsx`.** Export:
   - `export const <name>: Mod = { id, name, icon, description, pane? }`, where `pane` is `{ id, label? }` for a mod with a side pane: the id it opens under, and the panel button's words while it's closed
   - `export async function <name>View($, e): Promise<ModView>`: `{ headline, actions?, rows }`. The headline is one row, its state at a glance, kept when the hub is collapsed; `actions` are up to two Buttons beside it (the hub adds its panel button first when the mod has a pane); `rows` go underneath, one element per row, 5 shown and the rest scrolled. Color text with `hubColors()` from `hooks/hub.ts` so it matches the hub.
   - optional: `<name>Badge($, e)`, `<name>OpenPane($)` (and a case in `closePaneOf` if closing needs more than the pane going away), `<name>Enable($)`, `<name>Disable($)`
   - `export function register<Name>(on)` for hooks with a matcher of their own: its commands, its `Pane`
   - one `export async function <name><Event>($, e: ArgOf<'event'>, next: NextOf<'event'>)` per shared event it hooks (`session.start`, `turn.complete`, …)
2. **Make off mean off.** Start every handler that acts with `if (!isModOn(ID)) return next(e)`, and have each command answer `offText(NAME)` while the mod is off.
3. **Wire it in `hooks/mods/index.ts`.** Add it to `MODS`, call its register in `registerMods`, add a case to `viewOf`, `badgeOf`, `openPaneOf` and `switchedOf`, and chain its handlers into the `on<Event>` functions. If it hooks an event no mod hooked before, add an `on<Event>` there and one `on('<event>', …)` line in `hooks/register.tsx`.
4. **State:** values it keeps in `$.state` go in `types/index.d.ts` under `mods-hub`, with keys prefixed by the mod's name.

Then run `claude plugin validate .` and `claude plugin test .`. The next reload shows the new mod switched on, and starred if fewer than 4 mods are.

## Costs and limits

Keep-warm pings cost tokens. Prices shown are API list prices, which are only a yardstick on a subscription. Cache states come from a one-hour clock, not a live server check. Mods need Claude Code 2.1.287 or later. The hub draws in the terminal and the Desktop app; VS Code and mobile get the side panes and commands only.

Don't install this beside cache-tax-gui or the original cache-tax mod: you'd get two cold-send guards.

## Install

At the prompt of a terminal session:

```
/plugin install mods-hub --marketplace robhstone/claude-mods-hub
```

From a shell:

```
claude plugin install mods-hub --marketplace robhstone/claude-mods-hub
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `robhstone/claude-mods-hub`, then Add plugin.

Answer `y` to add the marketplace, then pick a scope. To work on it locally, clone the repository and run `claude --plugin-dir /path/to/claude-mods-hub`.

## Thanks

This hub stands on other people's work. Please go and star their repositories:

- **[Karan Bansal](https://github.com/karanb192)**: [cache-tax](https://github.com/karanb192/cache-tax) (MIT), which the Cache mod is based on.
- **[Theo Browne](https://github.com/t3dotgg)**: [tstack](https://github.com/t3dotgg/tstack) (MIT): Council, Sol Loop, Full Stop, Full Send, File PR, Babysit PR, Modernize and Takeover.
- **[Lauren Tan (poteto)](https://github.com/poteto)**: [pstack](https://github.com/cursor/plugins/tree/main/pstack) (MIT): Sharpen, How, Why, Arena, Interrogate and Blast Radius.
- **[Michael Denyer](https://github.com/michael-denyer)**: [pstack-claude](https://github.com/michael-denyer/pstack-claude) (MIT), the Claude Code port of pstack that the hub installs.
- **[Cursor](https://github.com/cursor)**: [thermos](https://github.com/cursor/plugins/tree/main/thermos) (MIT), the source of Thermonuclear, which reaches the hub through Michael's port.
- **[Matt Pocock](https://github.com/mattpocock)**: [skills](https://github.com/mattpocock/skills) (MIT): Grill with Docs, Grill Me, Ask Matt, To Spec, To Tickets, Wayfinder, Implement, Implement Spec, TDD, Diagnosing Bugs, Prototype, Code Review, Retro, Handoff and the rest of his flow.

The cards in the library are my own summaries. The skills belong to their authors and are downloaded from their repositories, under their own licenses.

## Tests

```
claude plugin validate .
claude plugin test .
```
