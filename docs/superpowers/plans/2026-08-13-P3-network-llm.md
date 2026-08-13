# P3 — Network/LLM plan (2026-08-13, rev 2 after adversarial audit)

Parent spec: `../specs/2026-08-12-perf-optimization-design.md`. Rev 1 BLOCKED (2 CRITICAL, 2 HIGH, M1-M9, L1-L5); all folded. Build order T1 → T2 → T3 → T4 → T5.

## T1 — Shared HTTP client + LLM resilience

1. `static CLIENT: OnceLock<reqwest::Client>` shared by llm.rs + llm_tools.rs + share.rs. **UA on the shared client** (`plutos-terminals`) — share.rs sets it client-level today and GitHub rejects UA-less requests (audit M4); harmless for LLM providers. `.connect_timeout(...)` set EXPLICITLY (reqwest has NO default — audit M5a); **NO client-level total timeout** (it would re-impose the streaming cap through the builder — M5b). `expect` on build (unrecoverable TLS init; get_or_init re-runs after panic — L5).
2. Non-streaming sites keep their per-call totals via `RequestBuilder::timeout` (60s complete / 120s tool turn / 30s gist — same total-including-body semantics as today, audit-verified).
3. Streaming: `.send()` wrapped in its own headers-timeout (M5c); per-chunk idle timeout (~90s) via `tokio::time::timeout` around each chunk read — **enable tokio's `time` feature** (not on today — M5d). NOT a client read_timeout (long non-streaming tool turns legitimately sit silent on the shared client).
4. Retry: 429/503/529, ≤2 retries honoring Retry-After (cap 30s; else 2s/8s), NON-streaming only. Agent transient no longer aborts a run (Rust retry absorbs it; agentLoop unchanged).

## T2 — Wire streaming in (incl. the Rust payload + cancel deliverables)

1. **Rust payload change (audit C2 — llm_stream/llm_complete accept only system+prompt today):** optional `messages: Vec<Value>` on BOTH commands (llmStream.js falls back to llm_complete with the same args), serialized per provider (Anthropic messages[]+system; OpenAI role array). DockAssistant then sends role-structured last-12-turns instead of one flattened user string.
2. **Cancel is a DELIVERABLE, not a verification (audit H1 — no contract exists on either side):** caller-minted request id → `llm_stream_cancel(id)` command flips a shared cancel token (map id→AtomicBool) checked each SSE-loop iteration; dropping `resp` closes the connection so the provider stops generating. llmStream returns `{promise, cancel}`.
3. Surfaces (audit L1 per-surface calls): **DockAssistant, SessionSummary, ErrorExplainer stream** (their render shapes pre-wrap; run/insert buttons are fence-regex-gated and appear only after the closing fence — no partial-command buttons). **AskBar stays BUFFERED** — its output lands in an editable review textarea after fence-stripping that needs complete text; streaming would clobber edits mid-arrival.
4. StrictMode/lifecycle (audit M3): per effect run, cleanup cancels the stream AND resets the ran-guard (or one AbortController per run) — SessionSummary's guard+cancel combination would otherwise dead-modal in dev; DockAssistant's unmount-mid-stream (dock tab switch) cancels.
5. Fallback discipline (audit M9): llmStream's catch-all → fall back to llm_complete ONLY on command-unavailable-class errors; provider errors rethrow (otherwise a 429 costs up to 4 provider hits once T1 retries exist).

## T3 — Anthropic prompt caching (agent mode)

llm_tools.rs, `kind == "anthropic"` ONLY (audit M2 — "anthropic-compat" gateways may 400 on the proprietary key; thread a flag into the pure serializer). Breakpoints (≤4 budget, we use 3): (a) last tools[] entry, (b) system (convert top-level string → block form), (c) **the LAST message** (audit L2: strictly cheaper than second-to-last; Anthropic auto-checks ~20 prior breakpoint positions so both hit). Shape-aware attachment (audit M1): skip when len<2 not needed for last-message form but the attacher must handle — assistant messages = block arrays (attach on last block), tool messages = tool_result one-element array (attach on the block), user messages = STRING content (convert to block form), empty system emits NO block. Cache-hit viability audit-CONFIRMED: agentLoop messages append-only, tools/system built once per run, serde ordering deterministic → byte-stable prefix. Sub-1024-token prefixes: silent no-op, fine. Payload snapshot tests pin the JSON for each message shape + the compat-flag-off case.

## T4 — Sync engine stops fetching per click

1. Surface-key gate: notifyChange early-returns when `surfaceValueKey(readSurface(stores))` (EXISTS already in syncState.js — reuse) equals the last key **recorded inside syncNow ON SUCCESS from what actually synced** (audit M8: recording at notify time + a busy-drop leaves changed-but-recorded state stuck until the 5-min poll). T4.1 + T4.3 land as ONE unit. The 5-min poll stays ungated (carries remote-inbound changes). Key cost: KB-scale stringify per save — microseconds vs the fetch it gates (audit-verified).
2. sync_git.rs: all 3 command bodies → spawn_blocking (git2 values created inside the closure — Send verified); `maybe_gc_at` → detached task after push returns, **serialized by a `static` tokio Mutex acquired by all three commands AND the gc task** (audit H2: unserialized, gc's dir-swap on POSIX succeeds under open handles and a concurrent push can commit the OLD workdir — silent settings revert; Windows rename just fails benignly). App-exit mid-gc already bounded (pre-clean + re-clone paths audit-verified).
3. busy-drop: pendingResync flag, re-run once on completion.
4. pushWithRePull: 1s/3s backoff ±20% jitter (JS setTimeout layer).

## T5 — Caches + leftovers

1. MCP tool cache: memoize per server id alongside McpConn; invalidate on add/remove/reconnect AND **`mcp_server_add` must also drop `conns()[id]`** (audit M7: edit-by-replace never dropped the conn — cache would refill from the stale process/env). Disable-toggle rides add; stale-tool calls already fail soft (is_error tool_result, loop continues). Keychain-secret-change staleness: pre-existing, out of scope, noted.
2. SFTP (audit C1 — REWRITTEN): **all sftp commands stay/become async with `dispatch` wrapped in spawn_blocking** (a `dispatch_async` helper); include `sftp_connect` (full TCP+SSH handshake currently on a tokio worker). `sftp_download`/`sftp_upload` are sync `pub fn` today and block the MAIN THREAD through the rfd dialog AND the whole transfer — dialog may stay main-thread if rfd requires, but the post-dialog transfer moves off it (async command + rfd::AsyncFileDialog, or spawn after the sync dialog). The rev-1 "non-async / matching sftp_download's pattern" sentence was wrong on both counts (non-async = MAIN thread; download is the anti-pattern).
   Frontend cache: keyed `(sessionId, path)` (audit M6 — path-only would serve session A's listing to session B in the docked browser), TTL ~10s, render-immediately-revalidate; **mutations invalidate the affected cwd entry (and a deleted/renamed dir's own entry) BEFORE refresh()** so a just-deleted row never repaints. sftp_home cached per sessionId.
3. UpdateBanner: `{etag, tag, checkedAt}` in localStorage, skip inside 24h, If-None-Match/304 no-op (works with the existing r.ok check). The two mounts are mutually exclusive branches; the 24h gate moots the remount + StrictMode cases (audit L3) — no hoist (it would newly overlay the lock screen).
4. netools ping/tracert `.output()` → spawn_blocking (tracert worst case ~67s on a tokio worker today — audit L4 corrected upward).

## Gates & measurement

Per task: cargo/vitest for pure logic (backoff policy, surface-key gate recording point, cache TTL/invalidation, cache_control serializer snapshots per message shape); full suites + build + clippy; per-task or batched reviews + whole-stream audit + re-review-every-fix. Measurables: handshakes/agent-run 14→1, cached-prefix tokens (snapshot), fetches/active-hour, TTFT property, sftp main-thread ops → 0.

## Non-goals

Model-list freshness, VNC/RDP frames, provider additions, P4 items.
