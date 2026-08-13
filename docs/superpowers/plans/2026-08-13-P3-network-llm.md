# P3 — Network/LLM plan (2026-08-13)

Parent spec: `../specs/2026-08-12-perf-optimization-design.md` (P3 section; file:line evidence there — re-verify against HEAD, P1/P2 moved some of it: net_latency/git_branch_status spawn_blocking already landed in P2-T4). Build order T1 → T2 → T3 → T4 → T5 (independent-ish; T2/T3 share llm files).

## T1 — Shared HTTP client + LLM resilience

1. `static CLIENT: OnceLock<reqwest::Client>` (llm.rs), shared by llm.rs + llm_tools.rs + share.rs — a fresh client per request discards the connection pool: every agent step pays DNS+TCP+TLS to the same host (14/run ≈ 1.5-4s pure setup). Per-call timeouts move to `RequestBuilder::timeout` (they differ per call site: 60s complete, 120s tool turn, 30s gist), NOT client-level.
2. Streaming timeout semantics: `llm_stream`'s 120s TOTAL cap kills long generations mid-stream → replace with connect timeout (client default ~30s) + per-chunk IDLE timeout (~90s between chunks) enforced in the read loop.
3. Retry/backoff: 429/503 (+ 529 overloaded) retried ≤2 times honoring `Retry-After` (cap 30s, else 2s/8s), NON-streaming paths only (a mid-stream retry would duplicate partial output). Agent loop stops aborting a whole run on one transient.

## T2 — Wire streaming in

`llmStream.js` is fully built with ZERO callers; every AI surface buffers (time-to-first-token = time-to-last-token).
1. DockAssistant: `invoke("llm_complete")` → `llmStream(...)` appending deltas to the in-progress message; also fix the history flattening (last 12 turns squashed into ONE user string) → role-structured messages array (provider-agnostic shape llm_stream already accepts — verify its payload contract first).
2. AskBar, ErrorExplainer, SessionSummary: same swap where the UX benefits (Ask returns a short command — stream still helps perceived latency; Summary = long output, biggest win).
3. Cancellation: closing the surface mid-stream must stop consumption (llmStream's existing cancel/unlisten contract — verify) and not leak listeners.

## T3 — Anthropic prompt caching (agent mode)

llm_tools.rs anthropic branch: `cache_control: {type: "ephemeral"}` on (a) the LAST tools[] entry, (b) the system block, (c) the second-to-last message content block. Agent runs resend full tool schemas + growing history every step — O(n²) tokens, ~100k redundant per 14-step run with MCP servers. Non-Anthropic providers untouched (flag keys only in the anthropic serializer). Verify against the current API shape (system as top-level string vs blocks — cache_control needs block form; convert if string).

## T4 — Sync engine stops fetching per click

1. `notifyChange()` (App.jsx save path) computes a cheap key of the SYNCED surface (syncState.js readSurface → stable JSON string or hash) and early-returns when unchanged since last schedule — today EVERY persist (pane focus, split, close) schedules a full git fetch after the 4s debounce, though only 4 keys sync.
2. sync_git.rs: all 3 commands' blocking git2 bodies → spawn_blocking; `maybe_gc_at` moves to a DETACHED task after push returns (today every ~21st push pays a full re-clone inline on a tokio worker).
3. busy-drop fix: `if (busy) return` in syncNow loses a change made during an in-flight sync for up to 5 min → set a pendingResync flag, re-run once on completion.
4. pushWithRePull: 4 zero-delay retries → backoff 1s/3s + ±20% jitter.

## T5 — Caches + leftovers

1. MCP tool list: memoize `Vec<Tool>` per server id alongside McpConn; invalidate on add/remove/reconnect (today every agent start re-queries every enabled server).
2. SFTP: `Map<path, {entries, at}>` TTL ~10s render-immediately-revalidate in SftpBrowser; cache sftp_home per sessionId. sftp.rs `dispatch()`'s blocking `rx.recv()` awaited from async fns → make those commands non-async (Tauri thread pool) or spawn_blocking, matching sftp_download's existing pattern.
3. UpdateBanner: `{etag, tag, checkedAt}` in localStorage — skip inside 24h, send If-None-Match, treat 304 as no-op; mount ONCE (App.jsx renders it in both branches today).
4. netools ping/tracert subprocess `.output()` → spawn_blocking (tracert = up to 22s on a tokio worker today).

## Gates & measurement

Per task: cargo/vitest for pure logic (backoff policy, surface-key gate, cache TTL, cache_control serializer shape — snapshot-test the JSON payload), full suites + build; per-task or batched reviews + whole-stream audit + re-review-every-fix. Measurables for the log: handshakes per agent run (1 vs 14), tokens per 14-step run (payload snapshot), fetches per active hour (derived), time-to-first-token (design property).

## Non-goals

Model-list freshness (static by design), VNC/RDP frame path, provider additions, P4 items.
