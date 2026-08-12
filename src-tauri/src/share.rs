// (C)
//! GitHub Gist create/delete for the "share a block/transcript" feature
//! (Stream D). Mirrors llm.rs's reqwest client pattern (see llm.rs:154-236) —
//! runs in Rust so the token never rides in a browser-origin request.
//!
//! AUDIT-CRITICAL: the token itself is NEVER returned to JS. `gist_auth_available`
//! reports only a fixed-vocabulary `source`/`detail` pair (never derived from the
//! `gh` subprocess's stdout, which IS the token). Every error string surfaced from
//! `gist_create`/`gist_delete` passes through `redact()` first, so a transport
//! error, a non-2xx response body, or anything else can never carry the token or
//! an `Authorization` header value to a JS toast.
//!
//! HARD BUILD CONSTRAINT (see docs/superpowers/plans/2026-07-21-D-gist-sharing.md,
//! "## HARD BUILD CONSTRAINT" at the top): creating/deleting a gist is an
//! outward-facing, irreversible PUBLISH. No test anywhere in this module ever
//! calls reqwest's `.send()` — see the doc comment on `share_tests` below. The
//! POST/DELETE only ever fire from JS through ShareModal's explicit confirm
//! button (Task D-4) / the "My shares" revoke action (Task D-5).

use serde::Serialize;
use std::process::Command;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

// Mirrors `commands::silent_command` (module-private there, so duplicated here
// rather than widening its visibility crate-wide just for this one extra
// caller) — suppresses the conhost.exe console flash when shelling out to `gh`.
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

fn silent_command<S: AsRef<std::ffi::OsStr>>(program: S) -> Command {
    #[cfg_attr(not(target_os = "windows"), allow(unused_mut))]
    let mut cmd = Command::new(program);
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

/// Keychain account for the gist-scope PAT — distinct from `sync-git-pat:v0`
/// (repo-scope, used by the vault cloud-sync feature). DO NOT reuse that one.
const GIST_PAT_ACCOUNT: &str = "github-gist-pat:v0";

/// FIXED CONSTANT — never parameterized, never derived from filename/content/
/// title. A content-derived description would be the same leak class the
/// fixed-filename scheme (buildShare, Stream D Task D-3) exists to close.
const GIST_DESCRIPTION: &str = "Shared via Pluto's Terminals";

// ── Token source resolution ────────────────────────────────────────────────

/// Where a usable GitHub token came from. Never carries the token itself — only
/// tells the caller which of the two sources won.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Source {
    Gh,
    Pat,
    None,
}

impl Source {
    fn as_str(self) -> &'static str {
        match self {
            Source::Gh => "gh",
            Source::Pat => "pat",
            Source::None => "none",
        }
    }
}

#[derive(Serialize, Debug)]
pub struct GistAuthAvailable {
    pub source: String,
    pub detail: String,
}

/// PURE — token-source precedence: `gh auth token` succeeding AND printing a
/// non-empty token wins; `gh` present but printing nothing, OR `gh` failing/
/// missing entirely, both fall through to the keychain PAT; otherwise "none".
/// No IO — `gh_ok`/`gh_out` are supplied by the caller.
///
/// AUDIT-CRITICAL: `detail` is drawn ONLY from the fixed 3-string vocabulary
/// below — never assembled from `gh_out` or `pat`, because `gh`'s stdout IS the
/// token. See `share_tests::detail_is_always_the_fixed_vocabulary` and
/// `share_tests::detail_never_carries_gh_out_bytes`.
fn resolve_token_source(gh_ok: bool, gh_out: &str, pat: Option<&str>) -> (Source, &'static str) {
    if gh_ok && !gh_out.trim().is_empty() {
        return (Source::Gh, "gh CLI");
    }
    if pat.map(|p| !p.trim().is_empty()).unwrap_or(false) {
        return (Source::Pat, "saved token");
    }
    (Source::None, "no token found")
}

/// Reports (but never returns) which token source is available. Returns a plain
/// struct rather than `Result` so there is no `Err` path a bug could route a
/// token value through.
#[tauri::command]
pub async fn gist_auth_available() -> GistAuthAvailable {
    let (gh_ok, gh_out) = match silent_command("gh").args(["auth", "token"]).output() {
        Ok(out) => (
            out.status.success(),
            String::from_utf8_lossy(&out.stdout).into_owned(),
        ),
        Err(_) => (false, String::new()),
    };
    // Any keychain error (locked, unavailable, …) reads the same as "no PAT
    // saved" — never propagated as an Err here (see the struct's doc comment).
    let pat = crate::vault::secret_get(GIST_PAT_ACCOUNT.to_string())
        .ok()
        .flatten();
    let (source, detail) = resolve_token_source(gh_ok, &gh_out, pat.as_deref());
    GistAuthAvailable {
        source: source.as_str().to_string(),
        detail: detail.to_string(),
    }
}

/// Impure sibling of `resolve_token_source`: actually fetches gh's token / the
/// keychain PAT and returns the real value for use in a request. NOT exposed to
/// JS and NOT one of the tested pure helpers — this is the one place the real
/// token value is held in memory, and it flows straight into `.bearer_auth()`.
fn resolve_token() -> Option<String> {
    if let Ok(out) = silent_command("gh").args(["auth", "token"]).output() {
        if out.status.success() {
            let tok = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !tok.is_empty() {
                return Some(tok);
            }
        }
    }
    crate::vault::secret_get(GIST_PAT_ACCOUNT.to_string())
        .ok()
        .flatten()
        .filter(|p| !p.trim().is_empty())
}

// ── Gist body assembly ─────────────────────────────────────────────────────

/// PURE — assembles the `POST /gists` body. `description` is the FIXED
/// constant (`GIST_DESCRIPTION`) regardless of `filename`/`content`.
fn build_gist_body(filename: &str, content: &str, public: bool) -> serde_json::Value {
    let mut file_obj = serde_json::Map::new();
    file_obj.insert("content".to_string(), serde_json::Value::from(content));

    let mut files = serde_json::Map::new();
    files.insert(filename.to_string(), serde_json::Value::Object(file_obj));

    let mut body = serde_json::Map::new();
    body.insert(
        "description".to_string(),
        serde_json::Value::from(GIST_DESCRIPTION),
    );
    body.insert("public".to_string(), serde_json::Value::from(public));
    body.insert("files".to_string(), serde_json::Value::Object(files));

    serde_json::Value::Object(body)
}

// ── Response parsing ───────────────────────────────────────────────────────

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GistCreated {
    pub id: String,
    pub url: String,
    pub html_url: String,
}

/// PURE — parses a gist API JSON response into `{id, url, htmlUrl}`. Err on any
/// missing/wrong-typed field rather than panicking on a garbage/partial body.
fn parse_gist_response(json: &serde_json::Value) -> Result<GistCreated, String> {
    let id = json
        .get("id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "gist response missing \"id\"".to_string())?
        .to_string();
    let url = json
        .get("url")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "gist response missing \"url\"".to_string())?
        .to_string();
    let html_url = json
        .get("html_url")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "gist response missing \"html_url\"".to_string())?
        .to_string();
    Ok(GistCreated { id, url, html_url })
}

/// Map a non-success gist API response to a readable message. GitHub's REST API
/// error bodies are `{"message": "...", "documentation_url": "..."}` — a
/// different shape from the `error.message` llm.rs's `http_error` expects from
/// Anthropic/OpenAI, so this is a small adapted sibling rather than a reuse.
/// Status is checked before parsing so a non-JSON body (e.g. an HTML 502 from a
/// proxy in front of the API) surfaces as text, not a decode error.
async fn gist_http_error(status: reqwest::StatusCode, resp: reqwest::Response) -> String {
    let body = resp.text().await.unwrap_or_default();
    if let Some(msg) = serde_json::from_str::<serde_json::Value>(&body)
        .ok()
        .and_then(|v| v.get("message").and_then(|m| m.as_str()).map(|s| s.to_string()))
    {
        return msg;
    }
    let excerpt: String = body.trim().chars().take(300).collect();
    if excerpt.is_empty() {
        status.to_string()
    } else {
        format!("{status}: {excerpt}")
    }
}

// ── Error redaction ────────────────────────────────────────────────────────

/// PURE — strip anything that looks like a bearer credential from an error
/// string before it can ever reach a JS toast. Two shapes are handled: (a) an
/// `Authorization: ...` header (any case) collapses everything after the header
/// name on that line to a fixed placeholder; (b) any token-shaped run of
/// [A-Za-z0-9_-] — a recognized GitHub token prefix, or 20+ characters typical
/// of an opaque bearer token/PAT — is replaced whole wherever it sits, even
/// glued to quotes/colons inside a JSON error body.
/// Applied to every error string gist_create/gist_delete can return. No regex
/// dependency is added — Cargo.toml is untouched per the plan's HARD RULES.
fn redact(s: String) -> String {
    s.lines().map(redact_line).collect::<Vec<_>>().join("\n")
}

fn redact_line(line: &str) -> String {
    if let Some(idx) = find_ci_ascii(line, "authorization") {
        return format!("{}Authorization: [redacted]", &line[..idx]);
    }
    // Segment the line into maximal runs of token-charset characters
    // [A-Za-z0-9_-] and check each run, passing every separator byte through
    // unchanged. Space-splitting alone missed credentials glued to punctuation
    // (a JSON error body echoing "token":"ghp_..." kept the quotes attached, so
    // the whole word failed the charset check and the raw token sailed through).
    let mut out = String::with_capacity(line.len());
    let mut run = String::new();
    for c in line.chars() {
        if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
            run.push(c);
        } else {
            flush_run(&mut run, &mut out);
            out.push(c);
        }
    }
    flush_run(&mut run, &mut out);
    out
}

fn flush_run(run: &mut String, out: &mut String) {
    if looks_like_token(run) {
        out.push_str("[redacted]");
    } else {
        out.push_str(run);
    }
    run.clear();
}

/// ASCII case-insensitive search. Avoids `to_lowercase()`, whose byte length can
/// differ from the original for some Unicode input, which would corrupt the byte
/// index used to slice `line`. Safe against non-char-boundary panics: a byte-
/// exact match of a pure-ASCII needle can only start at a genuine single-byte
/// ASCII position (UTF-8 continuation/lead bytes are always >= 0x80, so they can
/// never equal an ASCII letter byte), which is always a valid char boundary.
fn find_ci_ascii(haystack: &str, needle: &str) -> Option<usize> {
    let hb = haystack.as_bytes();
    let nb = needle.as_bytes();
    if nb.is_empty() || hb.len() < nb.len() {
        return None;
    }
    (0..=hb.len() - nb.len()).find(|&i| hb[i..i + nb.len()].eq_ignore_ascii_case(nb))
}

/// Is `word` shaped like a GitHub token or a generic opaque bearer secret?
fn looks_like_token(word: &str) -> bool {
    let w = word.trim_matches(|c: char| !c.is_ascii_alphanumeric() && c != '_' && c != '-');
    if w.len() < 8 {
        return false;
    }
    const KNOWN_PREFIXES: [&str; 6] = ["ghp_", "gho_", "ghu_", "ghs_", "ghr_", "github_pat_"];
    if KNOWN_PREFIXES.iter().any(|p| w.starts_with(p)) {
        return true;
    }
    w.len() >= 20 && w.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

// ── Commands ────────────────────────────────────────────────────────────────

/// `POST /gists`. Resolves the token fresh (gh first, then the keychain PAT —
/// independent of `gist_auth_available`, which never hands back the token
/// value). The POST is reachable from JS ONLY through ShareModal's explicit
/// confirm button (Task D-4) — nothing in this file calls it automatically.
#[tauri::command]
pub async fn gist_create(
    filename: String,
    content: String,
    public: bool,
) -> Result<GistCreated, String> {
    let token = resolve_token().ok_or_else(|| "no GitHub token".to_string())?;
    let body = build_gist_body(&filename, &content, public);

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .user_agent("plutos-terminals")
        .build()
        .map_err(|e| redact(e.to_string()))?;

    let resp = client
        .post("https://api.github.com/gists")
        .bearer_auth(&token)
        .header("Accept", "application/vnd.github+json")
        .json(&body)
        .send()
        .await
        .map_err(|e| redact(e.to_string()))?;

    let status = resp.status();
    if !status.is_success() {
        return Err(redact(gist_http_error(status, resp).await));
    }
    let json: serde_json::Value = resp.json().await.map_err(|e| redact(e.to_string()))?;
    parse_gist_response(&json).map_err(redact)
}

/// `DELETE /gists/{id}`. 404 is treated as already-gone (Ok) — revoking a share
/// that was already deleted by hand on github.com must not surface as an error
/// in "My shares".
#[tauri::command]
pub async fn gist_delete(id: String) -> Result<(), String> {
    // Path-injection guard: `id` is spliced directly into a URL path segment,
    // and this command is directly invokable from the webview. The normal
    // caller only ever passes back a GitHub-minted hex id from a prior
    // gist_create response, but the command itself must not trust that —
    // reject anything but a bare alphanumeric token so a crafted id like
    // "x/../../user/repos" can't retarget the request at a different API path
    // (mirrors the don't-trust-the-caller posture in commands::worktree_remove
    // / commands::mcp_install).
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err("invalid gist id".to_string());
    }
    let token = resolve_token().ok_or_else(|| "no GitHub token".to_string())?;

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .user_agent("plutos-terminals")
        .build()
        .map_err(|e| redact(e.to_string()))?;

    let resp = client
        .delete(format!("https://api.github.com/gists/{id}"))
        .bearer_auth(&token)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| redact(e.to_string()))?;

    let status = resp.status();
    if status.is_success() || status == reqwest::StatusCode::NOT_FOUND {
        return Ok(());
    }
    Err(redact(gist_http_error(status, resp).await))
}

// ── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod share_tests {
    //! Tests for share.rs's 4 PURE helpers ONLY: `resolve_token_source`,
    //! `build_gist_body`, `parse_gist_response`, `redact`. Per the HARD BUILD
    //! CONSTRAINT at the top of
    //! docs/superpowers/plans/2026-07-21-D-gist-sharing.md — creating/deleting a
    //! gist is an outward-facing, irreversible PUBLISH — NO test in this module
    //! (or anywhere in this crate) calls reqwest's `.send()`, performs a network
    //! request, or exercises a live GitHub token/`gh` subprocess. The three
    //! `#[tauri::command]` fns above are exercised only by hand, by pluto, at the
    //! Stream D manual smoke (Task D-6).
    use super::*;

    // ---- resolve_token_source ------------------------------------------------

    #[test]
    fn gh_nonempty_wins_over_pat() {
        let (source, detail) = resolve_token_source(true, "sometoken", Some("patval"));
        assert_eq!(source, Source::Gh);
        assert_eq!(detail, "gh CLI");
    }

    #[test]
    fn gh_ok_but_empty_stdout_falls_through_to_pat() {
        let (source, detail) = resolve_token_source(true, "", Some("patval"));
        assert_eq!(source, Source::Pat);
        assert_eq!(detail, "saved token");
        // Whitespace-only stdout counts as empty too.
        let (source2, _) = resolve_token_source(true, "   \n", Some("patval"));
        assert_eq!(source2, Source::Pat);
    }

    #[test]
    fn gh_failed_falls_through_to_pat() {
        let (source, detail) =
            resolve_token_source(false, "irrelevant-if-gh-failed", Some("patval"));
        assert_eq!(source, Source::Pat);
        assert_eq!(detail, "saved token");
    }

    #[test]
    fn pat_only_when_gh_absent() {
        let (source, detail) = resolve_token_source(false, "", Some("patval"));
        assert_eq!(source, Source::Pat);
        assert_eq!(detail, "saved token");
    }

    #[test]
    fn none_when_nothing_available() {
        let (source, detail) = resolve_token_source(false, "", None);
        assert_eq!(source, Source::None);
        assert_eq!(detail, "no token found");
        // gh "succeeded" with empty output and no PAT saved is still "none".
        let (source2, detail2) = resolve_token_source(true, "", None);
        assert_eq!(source2, Source::None);
        assert_eq!(detail2, "no token found");
    }

    #[test]
    fn empty_or_blank_pat_treated_as_absent() {
        let (source, _) = resolve_token_source(false, "", Some("   "));
        assert_eq!(source, Source::None);
        let (source2, _) = resolve_token_source(false, "", Some(""));
        assert_eq!(source2, Source::None);
    }

    #[test]
    fn detail_is_always_the_fixed_vocabulary() {
        // Structural proof: `detail` can ONLY ever be one of these 3 safe
        // literals — it is never assembled from gh_out/pat, so no token byte
        // can ride along regardless of input.
        const VOCAB: [&str; 3] = ["gh CLI", "saved token", "no token found"];
        let gh_outs = [
            "",
            "x",
            "ghp_realistictokenlookingvalue1234567890",
            "gh CLI",
            "saved token",
            "no token found",
        ];
        let pats: [Option<&str>; 4] = [None, Some(""), Some("p"), Some("saved token")];
        for gh_ok in [true, false] {
            for gh_out in gh_outs {
                for pat in pats {
                    let (_, detail) = resolve_token_source(gh_ok, gh_out, pat);
                    assert!(
                        VOCAB.contains(&detail),
                        "detail {detail:?} escaped the fixed vocabulary (gh_ok={gh_ok}, gh_out={gh_out:?}, pat={pat:?})"
                    );
                }
            }
        }
    }

    #[test]
    fn detail_never_carries_gh_out_bytes() {
        // Realistic/adversarial values gh's stdout might actually contain (gh's
        // stdout IS the token) — detail must never embed them, prefix collision
        // with the fixed vocabulary included.
        let adversarial = [
            "ghp_9f8e7d6c5b4a3210feedfacecafebabe1234",
            "some-very-long-opaque-token-abcdefghijklmnopqrstuvwxyz0123456789",
            "gh CLI leaked accidentally",
        ];
        for gh_out in adversarial {
            for pat in [None, Some("patval")] {
                let (_, detail) = resolve_token_source(true, gh_out, pat);
                assert!(
                    !detail.contains(gh_out),
                    "detail {detail:?} leaked gh_out {gh_out:?}"
                );
            }
        }
    }

    // ---- build_gist_body ------------------------------------------------------

    #[test]
    fn build_gist_body_shape() {
        let body = build_gist_body("plutos-terminal-share-2026-07-21.txt", "hello world", false);
        assert_eq!(body["description"], GIST_DESCRIPTION);
        assert_eq!(body["public"], false);
        assert_eq!(
            body["files"]["plutos-terminal-share-2026-07-21.txt"]["content"],
            "hello world"
        );
    }

    #[test]
    fn build_gist_body_public_flag_threads_through() {
        assert_eq!(build_gist_body("f.txt", "c", true)["public"], true);
        assert_eq!(build_gist_body("f.txt", "c", false)["public"], false);
    }

    #[test]
    fn build_gist_body_description_is_fixed_regardless_of_inputs() {
        // AUDIT-CRITICAL: a content-derived description is the same leak class
        // the fixed-filename scheme (buildShare, Task D-3) exists to close.
        let cases = [
            ("normal.txt", "plain content"),
            (
                "curl -H \"Authorization: Bearer sk-fake123\".txt",
                "irrelevant",
            ),
            (
                "f.txt",
                "contains a secret AKIAFAKEFAKEFAKEFAKE and Authorization: Bearer ghp_fake",
            ),
        ];
        for (filename, content) in cases {
            let body = build_gist_body(filename, content, true);
            assert_eq!(body["description"], GIST_DESCRIPTION);
            assert_eq!(body["description"], "Shared via Pluto's Terminals");
        }
    }

    // ---- parse_gist_response ----------------------------------------------------

    #[test]
    fn parse_gist_response_ok() {
        let json = serde_json::json!({
            "id": "abc123",
            "url": "https://api.github.com/gists/abc123",
            "html_url": "https://gist.github.com/abc123",
            "owner": { "login": "plutothedev" },
        });
        let parsed = parse_gist_response(&json).unwrap();
        assert_eq!(parsed.id, "abc123");
        assert_eq!(parsed.url, "https://api.github.com/gists/abc123");
        assert_eq!(parsed.html_url, "https://gist.github.com/abc123");
    }

    #[test]
    fn parse_gist_response_missing_id_is_err() {
        let json = serde_json::json!({ "url": "u", "html_url": "h" });
        assert!(parse_gist_response(&json).is_err());
    }

    #[test]
    fn parse_gist_response_missing_url_is_err() {
        let json = serde_json::json!({ "id": "i", "html_url": "h" });
        assert!(parse_gist_response(&json).is_err());
    }

    #[test]
    fn parse_gist_response_missing_html_url_is_err() {
        let json = serde_json::json!({ "id": "i", "url": "u" });
        assert!(parse_gist_response(&json).is_err());
    }

    #[test]
    fn parse_gist_response_wrong_type_is_err() {
        let json = serde_json::json!({ "id": 123, "url": "u", "html_url": "h" });
        assert!(parse_gist_response(&json).is_err());
    }

    // ---- redact -----------------------------------------------------------------

    #[test]
    fn redact_strips_authorization_header() {
        let msg =
            "request failed: Authorization: Bearer ghp_realtoken1234567890abcdef".to_string();
        let out = redact(msg);
        assert!(!out.contains("ghp_realtoken1234567890abcdef"));
        assert!(!out.to_lowercase().contains("bearer"));
        assert!(out.contains("Authorization: [redacted]"));
    }

    #[test]
    fn redact_strips_case_insensitive_header() {
        let out = redact("AUTHORIZATION: Bearer ghp_abcdefghijklmnopqrstuvwxyz".to_string());
        assert!(!out.contains("ghp_abcdefghijklmnopqrstuvwxyz"));
    }

    #[test]
    fn redact_strips_bare_token_shaped_word_without_header_label() {
        let out =
            redact("gh CLI error: invalid token ghp_9f8e7d6c5b4a3210feedfacecafebabe".to_string());
        assert!(!out.contains("ghp_9f8e7d6c5b4a3210feedfacecafebabe"));
    }

    #[test]
    fn redact_strips_long_opaque_token_without_known_prefix() {
        let out = redact("token abcdefghijklmnopqrstuvwxyz0123456789 rejected".to_string());
        assert!(!out.contains("abcdefghijklmnopqrstuvwxyz0123456789"));
    }

    #[test]
    fn redact_leaves_ordinary_text_alone() {
        let msg = "500: rate limited, try again later".to_string();
        assert_eq!(redact(msg.clone()), msg);
    }

    #[test]
    fn redact_strips_token_embedded_in_json_punctuation() {
        // A GitHub API error body can echo the credential inside JSON: the
        // token is glued to quotes/colons, so space-splitting never isolates it.
        let out = redact(
            r#"422: {"message":"Bad credentials","token":"ghp_9f8e7d6c5b4a3210feedfacecafebabe"}"#
                .to_string(),
        );
        assert!(!out.contains("ghp_9f8e7d6c5b4a3210feedfacecafebabe"));
        assert!(out.contains("[redacted]"));
    }

    #[test]
    fn redact_strips_opaque_token_glued_to_punctuation() {
        let out = redact(
            "curl: (22) error token=abcdefghijklmnopqrstuvwxyz0123456789,please retry".to_string(),
        );
        assert!(!out.contains("abcdefghijklmnopqrstuvwxyz0123456789"));
    }

    #[test]
    fn redact_preserves_separators_around_redacted_runs() {
        let out = redact(r#"x="ghp_9f8e7d6c5b4a3210feedfacecafebabe";"#.to_string());
        assert_eq!(out, r#"x="[redacted]";"#);
    }
}
