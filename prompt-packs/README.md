# Prompt Packs Catalog

A `.deck.json` prompt pack describes a multi-panel terminal layout you can clone in one click via the `📚 packs…` dropdown or `🔍 find` search in the app header. Each pack below is shipped in the binary — no separate download needed.

> **Quick start:** see `HOW_TO_USE.md` for the loading flow + `SCHEMA.md` for the file format. To author your own pack, copy `example.deck.json` and edit. Press `Ctrl+P` in the app to search this catalog by name or description.

**Catalog organization (25 functional + 1 reference):**

- **Coding** — claude-code-basic, dual-claude-pair, codebase-explorer, debug-session, code-review
- **Writing** — writing-helper, content-script-writer, tweet-thread-writer, email-drafter, landing-page-writer, prd-writer
- **Learning** — language-learning, interview-prep, prompt-engineer-lab, ai-tool-comparison
- **Productivity** — research-assistant, pros-vs-cons, rubber-duck, standup-prep, weekly-retro, journal-buddy, resume-tailoring
- **Life** — trip-planner, meal-planner
- **Pluto Style** — trading-workflow

---

## Coding

### `claude-code-basic`
Simplest possible Claude Code setup. One panel, one tab, one job. Best starting point for first-time users. **When to use:** focused single-task session.

### `dual-claude-pair`
Two Claudes side-by-side: one for hands-on edits (CODE), one for architecture/planning (PLAN). They don't share context — each gets a focused thread. **When to use:** stuck on a build and want to step over to "plan" mode without losing your code session.

### `codebase-explorer`
Two panes: Claude (read-first/recommend-second) + inspect shell. **When to use:** you've cloned an unfamiliar repo and need to map it before editing.

### `debug-session`
Two panes: Claude in root-cause-chaser mode + repro shell. Pushes back on symptom-patches (try/catch / default values / retry-loops). **When to use:** something is broken; you don't want a band-aid.

### `code-review`
Two panes: senior reviewer (BLOCKER / IMPORTANT / NIT severities, no praise filler) + follow-ups scratch. **When to use:** reviewing a diff before you PR.

---

## Writing

### `writing-helper`
Single Claude pane tuned for drafting/editing/critique. Conversation IS the deliverable; no file-edit bias. **When to use:** anything where you want the words back, not a plan to make the words.

### `content-script-writer`
Video / podcast / livestream script collaborator. Works in beats (hook/body/callbacks/close), returns camera-ready prose, matches your voice. **When to use:** YouTube long-form, shorts, podcasts, livestream scripts.

### `tweet-thread-writer`
Twitter/X thread writer that doesn't read like AI. Anchored to mechanics that make threads land — strong hook, one idea per tweet, callback at the end. **When to use:** drafting a thread.

### `email-drafter`
Single Claude pane that drafts email replies in your voice. 3-sentence default, no corporate filler, three tones (warm / neutral / firm). **When to use:** any email reply you've been putting off.

### `landing-page-writer`
Two panes: copywriter following hero/problem/solution/social-proof/CTA structure + scratch. Won't let you skip the value prop. **When to use:** writing landing-page copy that converts.

### `prd-writer`
Two panes: PM coach (problem / user / metric / scope cut) + draft scratch. Pulls out missing context before drafting. **When to use:** writing a product requirements doc.

---

## Learning

### `language-learning`
Patient language tutor with structured drills (5–7 exchanges per round). Uses target language for prompts; English only for grammar explanations at beginner level. **When to use:** 15-minute daily practice sessions.

### `interview-prep`
Mock interviewer with two panes (interviewer + notes). Stays neutral mid-loop (no "great answer!"), pushes back on vague claims, gives feedback after each answer + pattern summary at end. **When to use:** any interview prep — technical, behavioral, system-design, case, leadership.

### `prompt-engineer-lab` ⭐
Two panes: prompt-engineering tutor + clean test bench. Iterate on your prompts in real time — tutor rewrites, bench executes, you see what changed. **When to use:** improving any AI prompt for your daily workflow.

### `ai-tool-comparison`
Single Claude pane that helps you pick between AI tools (Claude / GPT / Gemini / specialized agents) for a specific task. Concrete tradeoffs grounded in real strengths. **When to use:** deciding what tool to use before starting a project.

---

## Productivity

### `research-assistant`
Two panes: researcher + notes scratch. Surfaces high-signal sources, summarizes each in 2 sentences, synthesizes across them. **When to use:** "I need to learn X in 30 minutes" — not skim.

### `pros-vs-cons`
Three panes: PRO side (argues only for) + CON side (argues only against) + SYNTHESIZER (finds the load-bearing assumption). **When to use:** decision-making when you're hedging instead of deciding.

### `rubber-duck`
Single Claude pane in pure rubber-duck mode. Asks short clarifying questions until you figure it out yourself. NEVER solves, never gives code, holds the role. **When to use:** stuck on something and can't tell why.

### `standup-prep`
Two panes: standup coach (yesterday / today / blockers) + update scratch. Forces structure 5 minutes before standup. **When to use:** before any daily-standup meeting.

### `weekly-retro`
Two panes: retro coach (shipped / blocked / next-week-bet / pattern-noticed) + retro doc. **When to use:** end-of-week reflection. Pairs with `journal-buddy`.

### `journal-buddy`
Single Claude pane for daily reflection. Three structured questions in 5 minutes — not therapy, not woo. Outputs a clean dated entry. **When to use:** every morning OR every evening, not both.

### `resume-tailoring`
Two panes: resume advisor (matches your bullets to the JD's emphasis) + draft scratch. Doesn't invent experience — surfaces what's already there. **When to use:** before applying to any specific job.

---

## Life

### `trip-planner`
Two panes: trip planner (specific itinerary based on real constraints) + plan scratch. **When to use:** planning any trip without 14 browser tabs.

### `meal-planner`
Two panes: meal planner (week of dinners + grocery list, time-budgeted) + grocery list scratch. **When to use:** Sunday meal-prep ritual or before any grocery run.

---

## Pluto Style

### `trading-workflow`
Three panes: Claude analysis (ICT methodology — FVG, OB, Power of Three, Killzones, OTE, Liquidity, MSS) + Python scratch + dated session journal. ICT-trader-specialized. **When to use:** futures trading session prep.

---

## Reference

### `example`
Don't load this for real work. Schema reference — every field with comments. Use as starting template when authoring your own pack. See `SCHEMA.md` for the field-by-field breakdown.

---

## Authoring your own pack

1. Copy `example.deck.json` → rename to `<your-slug>.deck.json`.
2. Edit `name` and `description`.
3. Replace `panels[]` with your actual layout.
4. Set `cwd` per tab — absolute path, `null` for home, or templated like `${USERPROFILE}/Documents/myrepo` (any process env var resolves).
5. Set `startCommands` per tab — array of commands run in sequence on shell spawn.
6. Set `systemPrompt` per tab — string auto-typed into Claude 2 seconds after spawn (the actual specialization mechanism).
7. Add `env_hints[]` for any env vars users need to set themselves.
8. Document anything tricky in `notes[]`.

To share your pack: open a PR adding it to this folder, OR publish a gist and tell people to use `🔗 from URL` in the app.

## Quality bar for shipped packs

- **Goes straight to first question** (don't introduce yourself or explain the format)
- **3-4 question opening intake** if applicable, anchoring scope before drafting
- **Concrete anti-patterns** (what Claude must NOT do)
- **Specific tone calibration** (not generic "be helpful")
- **Tested with real prompts** before shipping

## v1+ roadmap

- **Pack categories surfaced in the dropdown** — once catalog grows past ~30, group by category
- **Community pack marketplace** — submit packs without opening a PR
- **Pack signing** — community packs signed with a Pluto-controlled key for trust on third-party loads
