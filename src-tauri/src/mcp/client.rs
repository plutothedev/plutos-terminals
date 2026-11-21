// (C) MCP connection wrapper — a thin, stable adapter over the official `rmcp`
// SDK. The rest of the app talks to `McpConn` (connect / list_tools / call_tool)
// and our own `Tool` struct; rmcp owns the protocol, handshake, and transports.
//
// SAFETY-CRITICAL annotation mapping (see manager.rs / the agent approval gate):
//   read_only   = annotations.read_only_hint == Some(true), else false
//   destructive = annotations.destructive_hint when present, else !read_only
//                 (unannotated tools are treated as destructive unless the server
//                  explicitly marked them read-only — fail safe).
use std::collections::{BTreeMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;

use rmcp::model::{CallToolRequestParams, PaginatedRequestParams, Tool as RmcpTool};
use rmcp::service::{RoleClient, RunningService, ServiceError};
use rmcp::ClientCacheConfig;
use rmcp::transport::streamable_http_client::StreamableHttpClientTransportConfig;
use rmcp::transport::{StreamableHttpClientTransport, TokioChildProcess};
use rmcp::ServiceExt;
use process_wrap::tokio::CommandWrap;

/// The HTTP client rmcp's streamable transport talks through. rmcp's own
/// default (`from_config`) is reqwest 0.13 with reqwest's default redirects,
/// which strip the bearer token on a host or port change but NOT on https to
/// http at the same port: a TLS terminator on a non-default port answering
/// with an http:// Location would have received the MCP token in cleartext
/// (review 2026-10-05 reproduced it over real TLS). This one follows redirects
/// by the app's own rule (llm::redirect_allowed: the same host and port, never
/// down to http, so FastMCP's /mcp to /mcp/ hop on 127.0.0.1 still works) and
/// keeps rmcp's no-idle-pool setting. It is reqwest 0.13, rmcp's version, under
/// the `reqwest013` name; the app's own calls use 0.12.
pub(crate) fn mcp_http_client() -> Result<reqwest013::Client, String> {
    mcp_http_client_idle(MCP_READ_IDLE_TIMEOUT)
}

/// `mcp_http_client` with the idle gap as a parameter: the test seam.
fn mcp_http_client_idle(read_idle: Duration) -> Result<reqwest013::Client, String> {
    // reqwest 0.13 is compiled without a crypto provider of its own
    // (rustls-no-provider) and panics "No provider set" when the process has no
    // default. The updater installs ring only when it first checks for an
    // update, so an MCP connection that ran first, rmcp's old default client
    // included, panicked. Install ring the same way when nothing is set yet;
    // once something is installed this is a no-op.
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
    reqwest013::Client::builder()
        .pool_max_idle_per_host(0)
        // An idle-gap bound (it restarts on every byte read), not a total one:
        // see MCP_READ_IDLE_TIMEOUT.
        .read_timeout(read_idle)
        .redirect(reqwest013::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() > crate::llm::MAX_REDIRECTS {
                return attempt.error("too many redirects");
            }
            let allowed = attempt
                .previous()
                .first()
                .is_some_and(|first| crate::llm::redirect_allowed(first, attempt.url()));
            if allowed {
                attempt.follow()
            } else {
                attempt.stop()
            }
        }))
        .build()
        .map_err(|e| e.to_string())
}

/// The most one MCP reply over HTTP may hold: a whole JSON reply, or one SSE
/// event. 16 MiB, rmcp's default; a tool result bigger than this is past any
/// model's context anyway.
pub const MCP_MAX_RESPONSE_BYTES: usize = 16 * 1024 * 1024;
/// The most of an HTTP error body kept for the error message.
pub const MCP_MAX_ERROR_BYTES: usize = 64 * 1024;

// Bounds on a server the user added but the app does not trust (the same
// denial-of-service class as the size limits above). Each one ends the
// operation with an error naming it; tests/mcp_http_limits.rs and
// tests/mcp_mock.rs drive hostile servers against them.

/// The most tools/list pages one listing follows. rmcp's own list_all_tools
/// follows nextCursor with no cap into one growing Vec, so a server answering
/// small pages with a fresh cursor for ever took the app's memory a page at a
/// time. Real servers send one page, or a handful.
pub const MCP_MAX_TOOL_PAGES: usize = 50;
/// The most tools one server may advertise. Every tool's name, description
/// and schema go to the model on every agent turn, so a list anywhere near
/// this is already unusable; the cap only stops a list growing without end.
pub const MCP_MAX_TOOLS: usize = 5000;
/// The most tool text one server may advertise across every page: name,
/// description and serialized input schema, summed over its tools. The page
/// and tool caps count items, and one page may be 16 MiB
/// (MCP_MAX_RESPONSE_BYTES), so without this a listing could still hold
/// hundreds of MiB. 8 MiB is already far past any model's context.
pub const MCP_MAX_TOOLS_BYTES: usize = 8 * 1024 * 1024;
/// The longest nextCursor followed. Cursors are opaque tokens, usually tens of
/// bytes; every one sent is kept for the loop check, so without a cap a
/// listing could hold MCP_MAX_TOOL_PAGES cursors of 16 MiB each.
pub const MCP_MAX_CURSOR_BYTES: usize = 1024;
/// From spawning the process or opening the connection to the end of the
/// initialize handshake. A server that answers at all answers initialize in
/// well under a second; 30 s leaves room for a cold `npx` or `uvx` start that
/// downloads its package first.
pub const MCP_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(30);
/// One whole tool listing, every page included. A listing is a lookup, not
/// work, and an agent run waits on it before it starts.
pub const MCP_LIST_TIMEOUT: Duration = Duration::from_secs(60);
/// One whole tool call. Tools legitimately run long (a build, a test suite, a
/// crawl), so this is generous: it exists so a call that never ends releases
/// the server's lock in manager.rs instead of queueing every later call on
/// that server behind it for good. Ten minutes is past any tool an agent
/// should sit waiting on in one step.
pub const MCP_CALL_TIMEOUT: Duration = Duration::from_secs(600);
/// HTTP only: the longest gap between bytes read on one MCP request,
/// including the wait for response headers. It restarts on every read, so it
/// is not a cap on a call's length. Its job is to reap a socket that a
/// request's total bound above already gave up on, so no socket stays open in
/// silence for ever. It is set equal to MCP_CALL_TIMEOUT on purpose: a tool
/// that works for minutes and answers in one JSON reply with no progress in
/// between is legitimate, and a shorter idle gap would fail it before the call
/// bound does. The standalone GET stream rmcp opens reconnects on its own
/// after an idle cut (SseAutoReconnectStream), so an idle session is not lost.
pub const MCP_READ_IDLE_TIMEOUT: Duration = MCP_CALL_TIMEOUT;

/// The error text for an operation cut off by one of the timeouts above.
fn timeout_error(what: &str, limit: Duration) -> String {
    format!("{what}: timed out after {limit:?} without an answer from the server")
}

/// A tool advertised by a connected MCP server, normalized to the shape the rest
/// of the app consumes.
#[derive(Clone, Debug, serde::Serialize)]
pub struct Tool {
    pub server: String,
    pub name: String,
    pub description: String,
    /// JSON Schema for the tool's inputs.
    pub schema: serde_json::Value,
    pub read_only: bool,
    pub destructive: bool,
    /// The epoch of the connection that listed this tool (see
    /// `McpConn::epoch`). The agent hands it back with a call, so a call
    /// whose approval was decided from these annotations is refused if the
    /// server has been reconnected (possibly to a different process with
    /// different annotations) since.
    pub epoch: u64,
}

/// Source of connection epochs: unique per connection for the life of the
/// process, never reused, so two connections to one server never share one.
static NEXT_EPOCH: AtomicU64 = AtomicU64::new(1);

/// A live connection to a single MCP server. Holds the running rmcp client; the
/// server stays connected until this is dropped.
pub struct McpConn {
    server_id: String,
    client: RunningService<RoleClient, ()>,
    /// Set once a list or call on this connection ran out of time. The server
    /// is in an unknown state (a stdio server stuck on the call, an HTTP
    /// request still open), so manager.rs drops the connection and the next
    /// use reconnects instead of queueing behind it.
    timed_out: AtomicBool,
    /// Set once a list or call found the transport closed (a stdio server
    /// that exited, a session that ended). Every later request would fail the
    /// same way, so manager.rs drops it like a timed-out one.
    closed: AtomicBool,
    /// Unique to this connection (NEXT_EPOCH). Every tool it lists carries
    /// it, and manager.rs refuses a call that names an epoch other than the
    /// live connection's.
    epoch: u64,
}

/// Counts the bytes a value serializes to without keeping them.
struct ByteCount(usize);

impl std::io::Write for ByteCount {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0 = self.0.saturating_add(buf.len());
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// What one tool costs against MCP_MAX_TOOLS_BYTES: its name, description and
/// serialized input schema, the text that goes to the model on every turn.
fn tool_bytes(t: &RmcpTool) -> usize {
    let mut schema = ByteCount(0);
    let _ = serde_json::to_writer(&mut schema, &*t.input_schema);
    t.name.len().saturating_add(t.description.as_ref().map_or(0, |d| d.len())).saturating_add(schema.0)
}

/// Suppresses the console window a console program gets when the app (a
/// GUI-subsystem process) spawns it; the same value as commands.rs.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// The command a stdio server is spawned from (see connect_stdio_within).
fn stdio_command(command: &str, args: &[String], env: &BTreeMap<String, String>) -> CommandWrap {
    let mut cmd = tokio::process::Command::new(command);
    cmd.args(args);
    for (k, v) in env {
        cmd.env(k, v);
    }
    // The child is often only a launcher (npx, uvx, `cmd /c`) with the real
    // server as ITS child, so the whole tree is wrapped: a Job Object on
    // Windows, a process group on unix. rmcp then ends a connection like this
    // (rmcp 3.11 transport/child_process.rs):
    // - Close or eviction (the connection is dropped): rmcp's serve task
    //   closes the server's stdin and waits up to 3 s for it to exit. A
    //   server that exits by itself is not killed, and whatever it launched
    //   (a browser, an editor) is left alone, as before the tree was wrapped.
    //   A server still running after that (hung) is killed with kill(), which
    //   terminates the whole job (TerminateJobObject) or signals the whole
    //   group (killpg), so the real server behind a launcher dies too. (On
    //   unix rmcp first sends SIGTERM, also to the whole group, and waits
    //   another 3 s.)
    //   That wait cannot end early on a hung server that launched something:
    //   process-wrap's JobObjectChild::wait (and ProcessGroupChild::wait)
    //   first awaits the direct child's own exit, and reads the job's
    //   completion port only after it. (After that exit the Windows wait
    //   returns on the first job message, and the job's NEW_PROCESS and
    //   EXIT_PROCESS messages are queued by then. Windows calls job messages
    //   best-effort: were none queued, the wait would run out at 3 s and the
    //   kill would take what the server launched too; it never leaks the
    //   server.)
    // - A handshake that times out drops the transport: rmcp's
    //   ChildWithCleanup kills it the same way, tree and all.
    // - App quit kills nothing, as before.
    // No kill-on-drop wrapper: with it the job is created kill-on-close, so
    // every close, eviction, reconnect and app quit would also kill anything
    // a tool had launched (tests/mcp_mock.rs drives each case).
    let mut cmd = CommandWrap::from(cmd);
    #[cfg(windows)]
    {
        // main.rs sets windows_subsystem = "windows", so a console server
        // (node, python, cmd, uvx) spawned without CREATE_NO_WINDOW opens a
        // console window of its own, as commands.rs notes for every spawn.
        // A Command's own creation_flags would be overwritten by JobObject,
        // which sets the flags from the CreationFlags wrapper plus a
        // temporary CREATE_SUSPENDED it lifts once the child is in the job.
        // (The flags type is the windows crate's, which the app does not
        // name; it is built through the wrapper's own field.)
        let mut no_window = process_wrap::tokio::CreationFlags(Default::default());
        no_window.0 .0 = CREATE_NO_WINDOW;
        cmd.wrap(no_window);
        cmd.wrap(process_wrap::tokio::JobObject);
    }
    #[cfg(unix)]
    cmd.wrap(process_wrap::tokio::ProcessGroup::leader());
    cmd
}

impl McpConn {
    /// Connect to a stdio (child-process) MCP server. `serve` performs the
    /// initialize handshake before returning.
    pub async fn connect_stdio(
        server_id: String,
        command: &str,
        args: &[String],
        env: &BTreeMap<String, String>,
    ) -> Result<McpConn, String> {
        Self::connect_stdio_within(server_id, command, args, env, MCP_HANDSHAKE_TIMEOUT).await
    }

    /// `connect_stdio` with the handshake bound as a parameter: the test seam.
    #[doc(hidden)]
    pub async fn connect_stdio_within(
        server_id: String,
        command: &str,
        args: &[String],
        env: &BTreeMap<String, String>,
        limit: Duration,
    ) -> Result<McpConn, String> {
        let cmd = stdio_command(command, args, env);
        let transport = TokioChildProcess::new(cmd).map_err(|e| format!("spawn {command}: {e}"))?;
        let what = format!("mcp stdio handshake ({server_id})");
        let client = tokio::time::timeout(limit, ().serve(transport))
            .await
            .map_err(|_| timeout_error(&what, limit))?
            .map_err(|e| format!("{what}: {e}"))?;
        Ok(McpConn::new(server_id, client).await)
    }

    /// Connect to a streamable-HTTP MCP server, optionally with a bearer token.
    pub async fn connect_http(
        server_id: String,
        url: &str,
        bearer: Option<String>,
    ) -> Result<McpConn, String> {
        Self::connect_http_within(server_id, url, bearer, MCP_HANDSHAKE_TIMEOUT).await
    }

    /// `connect_http` with the handshake bound as a parameter: the test seam.
    #[doc(hidden)]
    pub async fn connect_http_within(
        server_id: String,
        url: &str,
        bearer: Option<String>,
        limit: Duration,
    ) -> Result<McpConn, String> {
        // A token goes only where the app sends API keys: https, or plain http
        // to localhost / a private-LAN address (llm::resolve_base's rule).
        if bearer.is_some() && crate::llm::resolve_base(url, url).is_err() {
            return Err(format!(
                "mcp ({server_id}): refusing to send the token to a non-HTTPS address. Use https:// (http:// is allowed only for localhost or a private-LAN address)."
            ));
        }
        // `auth_header` wants the raw bearer token (no "Bearer " prefix).
        // The size limits are rmcp's own defaults, set here by name so a change
        // of default upstream cannot quietly lift them (RUSTSEC-2026-0462: rmcp
        // before 3.9 read a reply of any size into memory). rmcp enforces them
        // in its reqwest client impl, so they hold for the client handed over
        // by with_client below. tests/mcp_http_limits.rs drives a hostile server.
        let config = StreamableHttpClientTransportConfig::with_uri(url.to_string())
            .max_json_response_size(MCP_MAX_RESPONSE_BYTES)
            .max_sse_event_size(MCP_MAX_RESPONSE_BYTES)
            .max_error_response_size(MCP_MAX_ERROR_BYTES);
        let config = match bearer {
            Some(token) => config.auth_header(token),
            None => config,
        };
        let http = mcp_http_client().map_err(|e| format!("mcp http client ({server_id}): {e}"))?;
        let transport = StreamableHttpClientTransport::with_client(http, config);
        let what = format!("mcp http handshake ({server_id})");
        let client = tokio::time::timeout(limit, ().serve(transport))
            .await
            .map_err(|_| timeout_error(&what, limit))?
            .map_err(|e| format!("{what}: {e}"))?;
        Ok(McpConn::new(server_id, client).await)
    }

    /// Wrap a client that finished its handshake. Both connect paths end
    /// here, so the response cache is turned off for every connection.
    async fn new(server_id: String, client: RunningService<RoleClient, ()>) -> McpConn {
        // rmcp 3.11 caches list results by default (ClientCacheConfig::default:
        // on, 512 entries, up to 24 h by the server's ttlMs) and, on an error,
        // serves the expired page instead (serve_stale_on_error). The app keeps
        // its own tool cache in manager.rs with explicit invalidation; a second
        // one underneath would hand a reconnect or a refresh an old tool list
        // (old read_only / destructive flags at the approval gate) and hide a
        // server's error behind a stale page.
        client.set_response_cache_config(ClientCacheConfig::disabled()).await;
        McpConn {
            server_id,
            client,
            timed_out: AtomicBool::new(false),
            closed: AtomicBool::new(false),
            epoch: NEXT_EPOCH.fetch_add(1, Ordering::Relaxed),
        }
    }

    /// This connection's epoch (see the `epoch` field).
    pub fn epoch(&self) -> u64 {
        self.epoch
    }

    /// Whether a list or call on this connection has run out of time (see the
    /// `timed_out` field).
    pub fn timed_out(&self) -> bool {
        self.timed_out.load(Ordering::Relaxed)
    }

    /// Whether this connection must not be used again: a list or call ran out
    /// of time, or the transport is closed (the server exited or the session
    /// ended). manager.rs drops such a connection and reconnects.
    pub fn unusable(&self) -> bool {
        self.timed_out() || self.closed.load(Ordering::Relaxed) || self.client.is_transport_closed()
    }

    /// The error text for an rmcp request error; a closed transport also
    /// marks the connection (see `closed`).
    fn service_error(&self, what: &str, e: ServiceError) -> String {
        if matches!(e, ServiceError::TransportClosed) {
            self.closed.store(true, Ordering::Relaxed);
        }
        format!("{what}: {e}")
    }

    /// Run `op` under `limit`; on expiry, mark the connection and name the bound.
    async fn bounded<T>(
        &self,
        what: &str,
        limit: Duration,
        op: impl std::future::Future<Output = Result<T, String>>,
    ) -> Result<T, String> {
        match tokio::time::timeout(limit, op).await {
            Ok(out) => out,
            Err(_) => {
                self.timed_out.store(true, Ordering::Relaxed);
                Err(timeout_error(what, limit))
            }
        }
    }

    /// List every tool the server advertises, normalized to our `Tool`.
    pub async fn list_tools(&self) -> Result<Vec<Tool>, String> {
        self.list_tools_within(MCP_LIST_TIMEOUT).await
    }

    /// `list_tools` with the total bound as a parameter: the test seam.
    #[doc(hidden)]
    pub async fn list_tools_within(&self, limit: Duration) -> Result<Vec<Tool>, String> {
        let what = format!("list_tools ({})", self.server_id);
        self.bounded(&what, limit, self.list_pages(&what)).await
    }

    /// Follow nextCursor page by page with rmcp's single-page `list_tools`,
    /// never its `list_all_tools` (no page cap, see MCP_MAX_TOOL_PAGES).
    async fn list_pages(&self, what: &str) -> Result<Vec<Tool>, String> {
        let mut tools = Vec::new();
        let mut bytes: usize = 0;
        let mut sent: HashSet<String> = HashSet::new();
        let mut cursor: Option<String> = None;
        for _ in 0..MCP_MAX_TOOL_PAGES {
            let page = self
                .client
                .list_tools(Some(PaginatedRequestParams::default().with_cursor(cursor.take())))
                .await
                .map_err(|e| self.service_error(what, e))?;
            if tools.len() + page.tools.len() > MCP_MAX_TOOLS {
                return Err(format!(
                    "{what}: the server lists more than MCP_MAX_TOOLS ({MCP_MAX_TOOLS}) tools; refused"
                ));
            }
            bytes = page.tools.iter().map(tool_bytes).fold(bytes, usize::saturating_add);
            if bytes > MCP_MAX_TOOLS_BYTES {
                return Err(format!(
                    "{what}: the server's tool names, descriptions and schemas pass MCP_MAX_TOOLS_BYTES ({MCP_MAX_TOOLS_BYTES} bytes); refused"
                ));
            }
            tools.extend(page.tools.into_iter().map(|t| self.map_tool(t)));
            // The cursor itself is the server's text and is never echoed.
            match page.next_cursor {
                // An empty cursor ends the listing too: JS clients loop
                // `while (cursor)`, so servers send "" to mean the last page.
                None => return Ok(tools),
                Some(next) if next.is_empty() => return Ok(tools),
                Some(next) if next.len() > MCP_MAX_CURSOR_BYTES => {
                    return Err(format!(
                        "{what}: the server sent a page cursor longer than MCP_MAX_CURSOR_BYTES ({MCP_MAX_CURSOR_BYTES} bytes); refused"
                    ));
                }
                // A cursor already asked for would serve a page already seen,
                // and again after it: a loop, refused before it is sent twice.
                Some(next) if !sent.insert(next.clone()) => {
                    return Err(format!("{what}: the server repeated a page cursor (a pagination loop); refused"));
                }
                Some(next) => cursor = Some(next),
            }
        }
        Err(format!(
            "{what}: the server kept paging past MCP_MAX_TOOL_PAGES ({MCP_MAX_TOOL_PAGES} pages); refused"
        ))
    }

    /// Invoke a tool. `args` should be a JSON object (other shapes pass no
    /// arguments). Returns the full CallToolResult serialized to JSON.
    pub async fn call_tool(
        &self,
        name: &str,
        args: serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        self.call_tool_within(name, args, MCP_CALL_TIMEOUT).await
    }

    /// `call_tool` with the total bound as a parameter: the test seam.
    #[doc(hidden)]
    pub async fn call_tool_within(
        &self,
        name: &str,
        args: serde_json::Value,
        limit: Duration,
    ) -> Result<serde_json::Value, String> {
        let mut params = CallToolRequestParams::new(name.to_string());
        if let serde_json::Value::Object(map) = args {
            params = params.with_arguments(map);
        }
        let what = format!("call_tool {name} ({})", self.server_id);
        // Dropping rmcp's call future on expiry sends notifications/cancelled
        // for the request (rmcp's send_request_cancel_on_drop).
        let call = async { self.client.call_tool(params).await.map_err(|e| self.service_error(&what, e)) };
        let result = self.bounded(&what, limit, call).await?;
        serde_json::to_value(result).map_err(|e| format!("serialize call result: {e}"))
    }

    /// Normalize an rmcp tool into our `Tool`, applying the fail-safe annotation
    /// mapping.
    fn map_tool(&self, t: RmcpTool) -> Tool {
        let read_only = t
            .annotations
            .as_ref()
            .and_then(|a| a.read_only_hint)
            == Some(true);
        let destructive = t
            .annotations
            .as_ref()
            .and_then(|a| a.destructive_hint)
            .unwrap_or(!read_only);
        let schema = serde_json::to_value(&*t.input_schema)
            .unwrap_or_else(|_| serde_json::json!({ "type": "object" }));
        Tool {
            server: self.server_id.clone(),
            name: t.name.to_string(),
            description: t.description.map(|d| d.to_string()).unwrap_or_default(),
            schema,
            read_only,
            destructive,
            epoch: self.epoch,
        }
    }
}

#[cfg(test)]
mod http_client_tests {
    use super::{mcp_http_client, McpConn};
    use crate::llm::list_models_tests::{json, serve};

    fn redirect(location: &str) -> String {
        format!("HTTP/1.1 307 Temporary Redirect\r\nlocation: {location}\r\ncontent-length: 0\r\nconnection: close\r\n\r\n")
    }

    #[tokio::test]
    async fn the_mcp_client_never_follows_a_redirect_off_its_host() {
        // The same server and port under another host name: the host alone
        // refuses the hop, so the token never travels with a second request.
        let port = std::sync::Arc::new(std::sync::OnceLock::<String>::new());
        let p = port.clone();
        let (base, heads) = serve(move |head| {
            if head.starts_with("post /mcp ") {
                redirect(&format!("http://127.0.0.1:{}/steal", p.get().unwrap()))
            } else {
                json(200, "{}")
            }
        })
        .await;
        port.set(base.rsplit(':').next().unwrap().to_string()).unwrap();
        let resp = mcp_http_client()
            .unwrap()
            .post(format!("{}/mcp", base.replace("127.0.0.1", "localhost")))
            .bearer_auth("mcp-secret-token")
            .body("{}")
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 307);
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        assert_eq!(heads.lock().unwrap().len(), 1, "the token followed the redirect");
    }

    #[tokio::test]
    async fn the_mcp_client_follows_a_same_host_redirect() {
        let (base, heads) = serve(|head| {
            if head.starts_with("get /a ") { redirect("/b") } else { json(200, "{}") }
        })
        .await;
        let resp = mcp_http_client().unwrap().get(format!("{}/a", base.replace("127.0.0.1", "localhost"))).send().await.unwrap();
        assert_eq!(resp.status(), 200);
        assert_eq!(heads.lock().unwrap().len(), 2);
    }

    #[test]
    fn connect_http_hands_rmcp_this_client() {
        // What connect_http builds the transport from cannot be observed without
        // a live MCP server, so the line is pinned in source, as
        // companion.rs source_pinned_contract_tests does.
        // A Windows checkout is CRLF (companion.rs source_pinned_contract_tests).
        let src = include_str!("client.rs").replace("\r\n", "\n");
        let fn_body = |sig: &str| {
            let start = src.find(sig).unwrap();
            src[start..start + src[start..].find("\n    }\n").unwrap()].to_string()
        };
        // connect_http is the public entry and only fixes the handshake bound;
        // connect_http_within (the seam the tests drive) builds the transport.
        let entry = fn_body("pub async fn connect_http(");
        assert!(
            entry.contains("Self::connect_http_within(server_id, url, bearer, MCP_HANDSHAKE_TIMEOUT)"),
            "{entry}"
        );
        assert!(!entry.contains("from_config"), "{entry}");
        let body = fn_body("pub async fn connect_http_within(");
        assert!(body.contains("let http = mcp_http_client()"), "{body}");
        assert!(body.contains("StreamableHttpClientTransport::with_client(http, config)"), "{body}");
        assert!(!body.contains("from_config"), "{body}");
        // The reply size limits (RUSTSEC-2026-0462) are set on this config.
        for limit in [
            ".max_json_response_size(MCP_MAX_RESPONSE_BYTES)",
            ".max_sse_event_size(MCP_MAX_RESPONSE_BYTES)",
            ".max_error_response_size(MCP_MAX_ERROR_BYTES)",
        ] {
            assert!(body.contains(limit), "{limit} missing: {body}");
        }
    }

    #[tokio::test]
    async fn a_server_that_goes_silent_is_cut_off_after_the_idle_gap() {
        // Accepts, reads the request, never answers. The idle timeout covers the
        // wait for response headers as well as gaps in the body, so the request
        // fails instead of holding the socket open for ever. Driven through the
        // idle seam with a short gap (a real socket and the real clock).
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let mut held = Vec::new();
            while let Ok((sock, _)) = listener.accept().await {
                held.push(sock);
            }
        });
        let gap = std::time::Duration::from_millis(300);
        let started = std::time::Instant::now();
        let out = tokio::time::timeout(
            std::time::Duration::from_secs(10),
            super::mcp_http_client_idle(gap).unwrap().post(format!("http://{addr}/mcp")).body("{}").send(),
        )
        .await
        .expect("a silent server held the request past the idle gap");
        let err = out.expect_err("a silent server answered");
        assert!(err.is_timeout(), "{err:?}");
        assert!(started.elapsed() < std::time::Duration::from_secs(3), "{:?}", started.elapsed());
    }

    #[test]
    fn the_mcp_client_uses_the_idle_timeout_constant() {
        let src = include_str!("client.rs").replace("\r\n", "\n");
        let start = src.find("pub(crate) fn mcp_http_client(").unwrap();
        let body = &src[start..start + src[start..].find("\n}\n").unwrap()];
        assert!(body.contains("mcp_http_client_idle(MCP_READ_IDLE_TIMEOUT)"), "{body}");
        let start = src.find("fn mcp_http_client_idle(").unwrap();
        let body = &src[start..start + src[start..].find("\n}\n").unwrap()];
        assert!(body.contains(".read_timeout(read_idle)"), "{body}");
    }

    #[tokio::test]
    async fn a_token_is_never_sent_to_a_plain_http_public_address() {
        // Refused before any connection is made (the address does not exist).
        let err = match McpConn::connect_http("s".into(), "http://mcp.invalid/mcp", Some("tok".into())).await {
            Err(e) => e,
            Ok(_) => panic!("connected"),
        };
        assert!(err.contains("refusing to send the token to a non-HTTPS address"), "{err}");
    }
}

#[cfg(test)]
mod stdio_command_tests {
    use super::stdio_command;

    #[cfg(windows)]
    #[test]
    fn a_stdio_server_gets_no_console_window_and_a_job_object() {
        // main.rs builds the app with windows_subsystem = "windows", so a
        // console server (node, python, cmd, uvx) spawned without
        // CREATE_NO_WINDOW opens a console window of its own. JobObject keeps
        // the flags a CreationFlags wrapper sets (process-wrap's
        // job_creation_flags only adds a temporary CREATE_SUSPENDED).
        let cmd = stdio_command("node", &[], &Default::default());
        let flags = cmd.get_wrap::<process_wrap::tokio::CreationFlags>().map(|f| f.0 .0);
        assert_eq!(flags, Some(0x0800_0000), "CREATE_NO_WINDOW is not set");
        assert!(cmd.has_wrap::<process_wrap::tokio::JobObject>(), "the server's tree is not in a job object");
    }

    #[cfg(unix)]
    #[test]
    fn a_stdio_server_gets_a_process_group() {
        let cmd = stdio_command("node", &[], &Default::default());
        assert!(cmd.has_wrap::<process_wrap::tokio::ProcessGroup>(), "the server's tree is not in a process group");
    }

    #[test]
    fn a_closed_connection_does_not_kill_what_the_server_launched() {
        // KillOnDrop would make the job kill-on-close: closing the job handle,
        // which happens on every close, eviction, reconnect and app quit,
        // would end a browser or an editor a tool had opened. Without it the
        // tree is killed only when rmcp's kill() runs: a server that did not
        // exit within its grace period, or a dropped handshake.
        // (tests/mcp_mock.rs drives both sides.)
        let src = include_str!("client.rs").replace("\r\n", "\n");
        let code = &src[..src.find("#[cfg(test)]").unwrap()];
        assert!(!code.contains("KillOnDrop"), "a kill-on-drop wrapper is back on the stdio command");
    }
}
