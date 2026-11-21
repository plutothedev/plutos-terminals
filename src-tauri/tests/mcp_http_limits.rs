// (C) Streamable-HTTP MCP client against a hostile local server.
//
// RUSTSEC-2026-0462: rmcp before 3.9 buffered an HTTP response body with no
// size limit, so an MCP server the user added could answer one request with an
// endless body and take the app's memory with it. These tests drive the app's
// own `McpConn::connect_http` (the path manager.rs uses) against a fake server
// on 127.0.0.1 that answers `initialize` with a valid reply padded past the
// client's limit, sent three ways: with a Content-Length, chunked with no
// length, and as one SSE event. A reply under the limit must still connect, and
// the tool list read over HTTP must keep the fail-safe annotation mapping
// (unannotated = destructive) and carry the bearer token.
//
// The same fake server also scripts the denial-of-service cases of the same
// class that are not about size: a tool list that pages for ever (rmcp's
// list_all_tools follows nextCursor with no cap), and a server that reads a
// request and then holds the socket open without answering (no timeout used to
// bound connect, list or call, and manager.rs holds the server's lock across a
// call). Timeouts are tested through the `_within` seams with short durations,
// against real sockets and the real clock (a paused tokio clock races bytes in
// flight on a real socket).
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use app_lib::mcp::client::McpConn;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

/// The limit the app sets for one JSON reply and one SSE event.
const LIMIT: usize = app_lib::mcp::client::MCP_MAX_RESPONSE_BYTES;

#[derive(Clone, Copy)]
enum Reply {
    Json,
    Chunked,
    Sse,
}

struct Seen {
    methods: Vec<String>,
    auth: Vec<Option<String>>,
    /// The cursor each tools/list asked for (None = the first page).
    cursors: Vec<Option<String>>,
}

/// The `result` of tools/list for the page a cursor asks for.
type ListFn = fn(Option<&str>) -> serde_json::Value;

/// What the fake server does. `hang` names a method the server reads and then
/// never answers, holding the socket open.
#[derive(Clone, Copy)]
struct Script {
    how: Reply,
    pad: usize,
    call: fn(&serde_json::Value) -> serde_json::Value,
    list: ListFn,
    hang: Option<&'static str>,
}

impl Script {
    fn new(how: Reply, pad: usize) -> Script {
        Script { how, pad, call: complete, list: two_tools, hang: None }
    }
}

/// One tool marked read-only, one with no annotations.
fn two_tools(_: Option<&str>) -> serde_json::Value {
    serde_json::json!({ "tools": [
        { "name": "look", "inputSchema": { "type": "object" },
          "annotations": { "readOnlyHint": true } },
        { "name": "wipe", "inputSchema": { "type": "object" } }
    ]})
}

async fn read_request(sock: &mut TcpStream) -> Option<(String, Vec<u8>)> {
    let mut buf = Vec::new();
    let mut tmp = [0u8; 8192];
    let head_end = loop {
        if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break i + 4;
        }
        match sock.read(&mut tmp).await {
            Ok(0) | Err(_) => return None,
            Ok(n) => buf.extend_from_slice(&tmp[..n]),
        }
    };
    let head = String::from_utf8_lossy(&buf[..head_end]).to_string();
    let len = head
        .lines()
        .find_map(|l| {
            let (k, v) = l.split_once(':')?;
            k.eq_ignore_ascii_case("content-length").then(|| v.trim().parse::<usize>().ok())?
        })
        .unwrap_or(0);
    let mut body = buf[head_end..].to_vec();
    while body.len() < len {
        match sock.read(&mut tmp).await {
            Ok(0) | Err(_) => return None,
            Ok(n) => body.extend_from_slice(&tmp[..n]),
        }
    }
    Some((head, body))
}

fn header(head: &str, name: &str) -> Option<String> {
    head.lines().find_map(|l| {
        let (k, v) = l.split_once(':')?;
        k.trim().eq_ignore_ascii_case(name).then(|| v.trim().to_string())
    })
}

async fn write_reply(sock: &mut TcpStream, how: Reply, body: &str) {
    let (ctype, payload) = match how {
        Reply::Sse => ("text/event-stream", format!("event: message\ndata: {body}\n\n")),
        _ => ("application/json", body.to_string()),
    };
    let common = format!("HTTP/1.1 200 OK\r\ncontent-type: {ctype}\r\nmcp-session-id: s1\r\nconnection: close\r\n");
    match how {
        Reply::Chunked => {
            let _ = sock.write_all(format!("{common}transfer-encoding: chunked\r\n\r\n").as_bytes()).await;
            for chunk in payload.as_bytes().chunks(64 * 1024) {
                let _ = sock.write_all(format!("{:x}\r\n", chunk.len()).as_bytes()).await;
                let _ = sock.write_all(chunk).await;
                let _ = sock.write_all(b"\r\n").await;
            }
            let _ = sock.write_all(b"0\r\n\r\n").await;
        }
        _ => {
            let _ = sock
                .write_all(format!("{common}content-length: {}\r\n\r\n", payload.len()).as_bytes())
                .await;
            let _ = sock.write_all(payload.as_bytes()).await;
        }
    }
    let _ = sock.shutdown().await;
}

/// A streamable-HTTP MCP server whose `initialize` reply carries `pad` bytes of
/// instructions, listing tools and answering calls as `script` says.
async fn fake_server(script: Script) -> (String, Arc<Mutex<Seen>>) {
    let Script { how, pad, call, list, hang } = script;
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://127.0.0.1:{}/mcp", listener.local_addr().unwrap().port());
    let seen = Arc::new(Mutex::new(Seen { methods: Vec::new(), auth: Vec::new(), cursors: Vec::new() }));
    let s = seen.clone();
    let padding = Arc::new("a".repeat(pad));
    tokio::spawn(async move {
        loop {
            let Ok((mut sock, _)) = listener.accept().await else { return };
            let s = s.clone();
            let padding = padding.clone();
            tokio::spawn(async move {
                let Some((head, body)) = read_request(&mut sock).await else { return };
                if !head.starts_with("POST ") {
                    // The optional server-to-client GET stream and the closing DELETE.
                    let _ = sock
                        .write_all(b"HTTP/1.1 405 Method Not Allowed\r\ncontent-length: 0\r\nconnection: close\r\n\r\n")
                        .await;
                    return;
                }
                let msg: serde_json::Value = serde_json::from_slice(&body).unwrap_or_default();
                let method = msg["method"].as_str().unwrap_or("").to_string();
                let cursor = msg["params"]["cursor"].as_str().map(str::to_string);
                {
                    let mut g = s.lock().unwrap();
                    g.methods.push(method.clone());
                    g.auth.push(header(&head, "authorization"));
                    if method == "tools/list" {
                        g.cursors.push(cursor.clone());
                    }
                }
                if hang == Some(method.as_str()) {
                    // Read the request, answer nothing, keep the socket open.
                    std::future::pending::<()>().await;
                }
                let id = msg["id"].clone();
                match method.as_str() {
                    "initialize" => {
                        let version = msg["params"]["protocolVersion"].clone();
                        let reply = serde_json::json!({
                            "jsonrpc": "2.0", "id": id,
                            "result": {
                                "protocolVersion": version,
                                "capabilities": { "tools": {} },
                                "serverInfo": { "name": "fake", "version": "1" },
                                "instructions": padding.as_str(),
                            }
                        });
                        write_reply(&mut sock, how, &reply.to_string()).await;
                    }
                    "tools/list" => {
                        // A list fn answers a JSON-RPC error by returning
                        // { "__error": {...} } in place of a result.
                        let result = list(cursor.as_deref());
                        let reply = match result.get("__error") {
                            Some(err) => serde_json::json!({ "jsonrpc": "2.0", "id": id, "error": err }),
                            None => serde_json::json!({ "jsonrpc": "2.0", "id": id, "result": result }),
                        };
                        write_reply(&mut sock, Reply::Json, &reply.to_string()).await;
                    }
                    "tools/call" => {
                        let reply = serde_json::json!({ "jsonrpc": "2.0", "id": id, "result": call(&msg) });
                        write_reply(&mut sock, Reply::Json, &reply.to_string()).await;
                    }
                    _ => {
                        // Notifications (notifications/initialized) get 202 Accepted.
                        let _ = sock
                            .write_all(b"HTTP/1.1 202 Accepted\r\ncontent-length: 0\r\nconnection: close\r\n\r\n")
                            .await;
                    }
                }
            });
        }
    });
    (url, seen)
}

fn complete(_: &serde_json::Value) -> serde_json::Value {
    serde_json::json!({ "content": [{ "type": "text", "text": "done" }] })
}

async fn connect(how: Reply, pad: usize) -> (Result<McpConn, String>, Arc<Mutex<Seen>>) {
    connect_with(how, pad, complete).await
}

async fn connect_with(
    how: Reply,
    pad: usize,
    call: fn(&serde_json::Value) -> serde_json::Value,
) -> (Result<McpConn, String>, Arc<Mutex<Seen>>) {
    connect_script(Script { call, ..Script::new(how, pad) }).await
}

async fn connect_script(script: Script) -> (Result<McpConn, String>, Arc<Mutex<Seen>>) {
    let (url, seen) = fake_server(script).await;
    let conn = tokio::time::timeout(
        std::time::Duration::from_secs(60),
        McpConn::connect_http("hostile".into(), &url, Some("tok".into())),
    )
    .await
    .expect("connect_http hung");
    (conn, seen)
}

fn refused(r: Result<McpConn, String>) -> String {
    match r {
        Err(e) => e,
        Ok(_) => panic!("an initialize reply over the limit was accepted (the client buffered it)"),
    }
}

#[tokio::test]
async fn an_oversized_reply_with_a_content_length_is_refused() {
    let (r, _) = connect(Reply::Json, LIMIT + 1024 * 1024).await;
    let e = refused(r);
    assert!(e.contains("maximum size"), "{e}");
}

#[tokio::test]
async fn an_oversized_chunked_reply_with_no_length_is_refused() {
    let (r, _) = connect(Reply::Chunked, LIMIT + 1024 * 1024).await;
    let e = refused(r);
    assert!(e.contains("maximum size"), "{e}");
}

#[tokio::test]
async fn an_oversized_sse_event_is_refused() {
    // rmcp drops an over-limit SSE event inside the stream, so the handshake
    // reports the stream ending rather than the size; the paired test below
    // (the same reply just under the limit connects) shows the size is why.
    let (r, _) = connect(Reply::Sse, LIMIT + 1024 * 1024).await;
    let e = refused(r);
    assert!(e.contains("mcp http handshake"), "{e}");
}

#[tokio::test]
async fn a_reply_under_the_limit_connects_and_lists_tools_fail_safe() {
    // 15 MiB of padding plus the envelope stays under 16 MiB.
    let (r, seen) = connect(Reply::Json, LIMIT - 1024 * 1024).await;
    let conn = r.expect("an initialize reply under the limit must connect");
    let tools = conn.list_tools().await.expect("list over http");
    let look = tools.iter().find(|t| t.name == "look").unwrap();
    let wipe = tools.iter().find(|t| t.name == "wipe").unwrap();
    assert!(look.read_only && !look.destructive, "read-only hint honoured");
    assert!(!wipe.read_only && wipe.destructive, "unannotated tool must count as destructive");
    let g = seen.lock().unwrap();
    assert!(g.methods.iter().any(|m| m == "tools/list"), "{:?}", g.methods);
    assert!(
        g.auth.iter().all(|a| a.as_deref() == Some("Bearer tok")),
        "every request carries the bearer: {:?}",
        g.auth
    );
}

#[tokio::test]
async fn an_sse_reply_under_the_limit_connects() {
    let (r, _) = connect(Reply::Sse, LIMIT - 1024 * 1024).await;
    r.expect("an SSE initialize reply under the limit must connect");
}

fn calls(seen: &Arc<Mutex<Seen>>) -> usize {
    seen.lock().unwrap().methods.iter().filter(|m| *m == "tools/call").count()
}

#[tokio::test]
async fn a_server_that_always_wants_more_input_ends_in_an_error() {
    // rmcp 3.x retries a tools/call that comes back "input_required" (SEP-2322).
    // A server that never finishes must not hold the call (and the per-server
    // lock in manager.rs) for ever: the retries are capped.
    fn forever(_: &serde_json::Value) -> serde_json::Value {
        serde_json::json!({ "resultType": "input_required", "requestState": "again" })
    }
    let (r, seen) = connect_with(Reply::Json, 0, forever).await;
    let conn = r.expect("connect");
    let out = tokio::time::timeout(
        std::time::Duration::from_secs(30),
        conn.call_tool("wipe", serde_json::json!({})),
    )
    .await
    .expect("call_tool hung on endless input_required");
    assert!(out.is_err(), "{out:?}");
    let n = calls(&seen);
    assert!((1..=10).contains(&n), "tools/call sent {n} times");
}

#[tokio::test]
async fn a_server_asking_the_app_to_run_a_model_gets_nothing() {
    // An input_required round can carry a sampling request (run a model for
    // the server). The app offers no sampling or elicitation handler, so the
    // call fails instead of spending the user's model key for the server.
    fn sample(_: &serde_json::Value) -> serde_json::Value {
        serde_json::json!({
            "resultType": "input_required",
            "inputRequests": { "k": {
                "method": "sampling/createMessage",
                "params": { "messages": [], "maxTokens": 10 }
            }}
        })
    }
    let (r, seen) = connect_with(Reply::Json, 0, sample).await;
    let conn = r.expect("connect");
    let out = conn.call_tool("wipe", serde_json::json!({})).await;
    assert!(out.is_err(), "{out:?}");
    assert_eq!(calls(&seen), 1, "no retry after a refused sampling request");
}

#[tokio::test]
async fn a_finished_call_serializes_with_its_content() {
    let (r, _) = connect(Reply::Json, 0).await;
    let conn = r.expect("connect");
    let out = conn.call_tool("wipe", serde_json::json!({"a": 1})).await.expect("call");
    assert_eq!(out["content"][0]["text"], "done", "{out}");
    assert!(!conn.timed_out(), "a finished call must not mark its connection");
}

#[tokio::test]
async fn a_failed_call_still_says_is_error() {
    // AgentMode.jsx reads `isError` off the serialized result to tell the model
    // a tool failed; the field name must survive the rmcp upgrade.
    fn failed(_: &serde_json::Value) -> serde_json::Value {
        serde_json::json!({ "content": [{ "type": "text", "text": "no" }], "isError": true })
    }
    let (r, _) = connect_with(Reply::Json, 0, failed).await;
    let out = r.expect("connect").call_tool("wipe", serde_json::json!({})).await.expect("call");
    assert_eq!(out["isError"], true, "{out}");
}

// ---- Pagination (M1) ------------------------------------------------------

use app_lib::mcp::client::{MCP_MAX_CURSOR_BYTES, MCP_MAX_TOOLS, MCP_MAX_TOOLS_BYTES, MCP_MAX_TOOL_PAGES};

fn lists(seen: &Arc<Mutex<Seen>>) -> usize {
    seen.lock().unwrap().methods.iter().filter(|m| *m == "tools/list").count()
}

/// A guard well past anything the fix needs: before the fix these tests hang
/// here (rmcp kept asking for the next page for ever).
async fn list_guarded(conn: &McpConn) -> Result<Vec<app_lib::mcp::client::Tool>, String> {
    tokio::time::timeout(Duration::from_secs(20), conn.list_tools())
        .await
        .expect("list_tools hung: it kept following nextCursor")
}

#[tokio::test]
async fn endless_pagination_stops_at_the_page_cap() {
    // One tool and a fresh cursor on every page, for ever.
    fn endless(cursor: Option<&str>) -> serde_json::Value {
        let n: u64 = cursor.and_then(|c| c.strip_prefix('c')?.parse().ok()).unwrap_or(0);
        serde_json::json!({
            "tools": [{ "name": format!("t{n}"), "inputSchema": { "type": "object" } }],
            "nextCursor": format!("c{}", n + 1)
        })
    }
    let (r, seen) = connect_script(Script { list: endless, ..Script::new(Reply::Json, 0) }).await;
    let conn = r.expect("connect");
    let started = Instant::now();
    let e = list_guarded(&conn).await.expect_err("an endless tool list was accepted");
    assert!(started.elapsed() < Duration::from_secs(10), "took {:?}", started.elapsed());
    assert!(e.contains("MCP_MAX_TOOL_PAGES"), "{e}");
    assert_eq!(lists(&seen), MCP_MAX_TOOL_PAGES, "pages requested");
}

#[tokio::test]
async fn a_repeated_cursor_is_refused_as_a_loop() {
    fn looping(_: Option<&str>) -> serde_json::Value {
        serde_json::json!({
            "tools": [{ "name": "t", "inputSchema": { "type": "object" } }],
            "nextCursor": "same"
        })
    }
    let (r, seen) = connect_script(Script { list: looping, ..Script::new(Reply::Json, 0) }).await;
    let conn = r.expect("connect");
    let e = list_guarded(&conn).await.expect_err("a looping cursor was followed");
    assert!(e.contains("repeated"), "{e}");
    // Page 1 (no cursor), page "same", then "same" again is refused unsent.
    assert_eq!(lists(&seen), 2, "pages requested");
}

#[tokio::test]
async fn more_tools_than_the_cap_is_refused() {
    // Two pages of 3,000 tools each: few pages, too many tools.
    fn crowded(cursor: Option<&str>) -> serde_json::Value {
        let page = cursor.unwrap_or("p1").to_string();
        let tools: Vec<_> = (0..3000)
            .map(|i| serde_json::json!({ "name": format!("{page}-{i}"), "inputSchema": { "type": "object" } }))
            .collect();
        match cursor {
            None => serde_json::json!({ "tools": tools, "nextCursor": "p2" }),
            Some(_) => serde_json::json!({ "tools": tools }),
        }
    }
    const { assert!(6000 > MCP_MAX_TOOLS) };
    let (r, _) = connect_script(Script { list: crowded, ..Script::new(Reply::Json, 0) }).await;
    let conn = r.expect("connect");
    let e = list_guarded(&conn).await.expect_err("6,000 tools were accepted");
    assert!(e.contains("MCP_MAX_TOOLS"), "{e}");
}

#[tokio::test]
async fn three_pages_list_every_tool_fail_safe() {
    fn three(cursor: Option<&str>) -> serde_json::Value {
        match cursor {
            None => serde_json::json!({
                "tools": [{ "name": "look", "inputSchema": { "type": "object" },
                            "annotations": { "readOnlyHint": true } }],
                "nextCursor": "p2"
            }),
            Some("p2") => serde_json::json!({
                "tools": [{ "name": "wipe", "inputSchema": { "type": "object" } }],
                "nextCursor": "p3"
            }),
            _ => serde_json::json!({
                "tools": [{ "name": "note", "inputSchema": { "type": "object" },
                            "annotations": { "destructiveHint": false } }]
            }),
        }
    }
    let (r, seen) = connect_script(Script { list: three, ..Script::new(Reply::Json, 0) }).await;
    let conn = r.expect("connect");
    let tools = list_guarded(&conn).await.expect("three pages");
    let names: Vec<_> = tools.iter().map(|t| t.name.as_str()).collect();
    assert_eq!(names, ["look", "wipe", "note"]);
    let flags: Vec<_> = tools.iter().map(|t| (t.read_only, t.destructive)).collect();
    // read-only hint honoured; unannotated = destructive; an explicit
    // destructiveHint false without readOnlyHint is neither.
    assert_eq!(flags, [(true, false), (false, true), (false, false)]);
    assert!(tools.iter().all(|t| t.server == "hostile"));
    let g = seen.lock().unwrap();
    assert_eq!(g.cursors, [None, Some("p2".to_string()), Some("p3".to_string())]);
}

#[tokio::test]
async fn exactly_the_tool_cap_is_accepted() {
    fn full(_: Option<&str>) -> serde_json::Value {
        let tools: Vec<_> = (0..MCP_MAX_TOOLS)
            .map(|i| serde_json::json!({ "name": format!("t{i}"), "inputSchema": { "type": "object" } }))
            .collect();
        serde_json::json!({ "tools": tools })
    }
    let (r, _) = connect_script(Script { list: full, ..Script::new(Reply::Json, 0) }).await;
    let tools = list_guarded(&r.expect("connect")).await.expect("exactly MCP_MAX_TOOLS tools");
    assert_eq!(tools.len(), MCP_MAX_TOOLS);
}

#[tokio::test]
async fn one_tool_past_the_cap_is_refused() {
    fn over(_: Option<&str>) -> serde_json::Value {
        let tools: Vec<_> = (0..=MCP_MAX_TOOLS)
            .map(|i| serde_json::json!({ "name": format!("t{i}"), "inputSchema": { "type": "object" } }))
            .collect();
        serde_json::json!({ "tools": tools })
    }
    let (r, _) = connect_script(Script { list: over, ..Script::new(Reply::Json, 0) }).await;
    let e = list_guarded(&r.expect("connect")).await.expect_err("MCP_MAX_TOOLS + 1 tools were accepted");
    assert!(e.contains("MCP_MAX_TOOLS"), "{e}");
}

/// 5 MiB: two of these pass the byte budget, one does not.
const HEAVY: usize = 5 * 1024 * 1024;

#[tokio::test]
async fn tool_text_past_the_byte_budget_is_refused() {
    // Two tools on two pages, each page well under the 16 MiB reply limit:
    // a 5 MiB description, then a 5 MiB input schema. Few pages and few
    // tools, but 10 MiB of text for the model; both parts must count.
    fn heavy(cursor: Option<&str>) -> serde_json::Value {
        match cursor {
            None => serde_json::json!({
                "tools": [{ "name": "a", "description": "d".repeat(HEAVY), "inputSchema": { "type": "object" } }],
                "nextCursor": "p2"
            }),
            Some(_) => serde_json::json!({
                "tools": [{ "name": "b", "inputSchema": { "type": "object", "description": "s".repeat(HEAVY) } }]
            }),
        }
    }
    const { assert!(2 * HEAVY > MCP_MAX_TOOLS_BYTES && HEAVY < MCP_MAX_TOOLS_BYTES) };
    let (r, seen) = connect_script(Script { list: heavy, ..Script::new(Reply::Json, 0) }).await;
    let e = list_guarded(&r.expect("connect")).await.expect_err("10 MiB of tool text was accepted");
    assert!(e.contains("MCP_MAX_TOOLS_BYTES"), "{e}");
    assert_eq!(lists(&seen), 2, "pages requested");
}

#[tokio::test]
async fn tool_text_under_the_byte_budget_is_accepted() {
    fn one_heavy(_: Option<&str>) -> serde_json::Value {
        serde_json::json!({
            "tools": [{ "name": "a", "description": "d".repeat(HEAVY), "inputSchema": { "type": "object" } }]
        })
    }
    let (r, _) = connect_script(Script { list: one_heavy, ..Script::new(Reply::Json, 0) }).await;
    let tools = list_guarded(&r.expect("connect")).await.expect("5 MiB of tool text");
    assert_eq!(tools[0].description.len(), HEAVY);
}

#[tokio::test]
async fn a_cursor_past_the_length_cap_is_refused_unsent() {
    fn long(cursor: Option<&str>) -> serde_json::Value {
        match cursor {
            None => serde_json::json!({
                "tools": [{ "name": "t", "inputSchema": { "type": "object" } }],
                "nextCursor": "c".repeat(MCP_MAX_CURSOR_BYTES + 1)
            }),
            Some(_) => serde_json::json!({ "tools": [] }),
        }
    }
    let (r, seen) = connect_script(Script { list: long, ..Script::new(Reply::Json, 0) }).await;
    let e = list_guarded(&r.expect("connect")).await.expect_err("an over-long cursor was followed");
    assert!(e.contains("MCP_MAX_CURSOR_BYTES"), "{e}");
    assert!(!e.contains("cccc"), "the cursor text was echoed: {e}");
    assert_eq!(lists(&seen), 1, "pages requested");
}

#[tokio::test]
async fn a_cursor_at_the_length_cap_is_followed() {
    fn at_cap(cursor: Option<&str>) -> serde_json::Value {
        match cursor {
            None => serde_json::json!({
                "tools": [{ "name": "t1", "inputSchema": { "type": "object" } }],
                "nextCursor": "c".repeat(MCP_MAX_CURSOR_BYTES)
            }),
            Some(_) => serde_json::json!({ "tools": [{ "name": "t2", "inputSchema": { "type": "object" } }] }),
        }
    }
    let (r, seen) = connect_script(Script { list: at_cap, ..Script::new(Reply::Json, 0) }).await;
    let tools = list_guarded(&r.expect("connect")).await.expect("a cursor at the cap");
    assert_eq!(tools.len(), 2);
    assert_eq!(lists(&seen), 2, "pages requested");
}

#[tokio::test]
async fn an_empty_next_cursor_ends_the_listing() {
    // JS clients loop `while (cursor)`, so "" means no more pages.
    fn empty(_: Option<&str>) -> serde_json::Value {
        serde_json::json!({
            "tools": [{ "name": "t", "inputSchema": { "type": "object" } }],
            "nextCursor": ""
        })
    }
    let (r, seen) = connect_script(Script { list: empty, ..Script::new(Reply::Json, 0) }).await;
    let tools = list_guarded(&r.expect("connect")).await.expect("an empty cursor ends the list");
    assert_eq!(tools.len(), 1);
    assert_eq!(lists(&seen), 1, "pages requested");
}

// ---- rmcp's response cache (off) -----------------------------------------

#[tokio::test]
async fn a_list_the_server_marked_cacheable_is_still_reread() {
    // The server says its first page stays fresh for a minute, then changes
    // its tools. rmcp 3.11 caches the page by default; the app must not, so the
    // agent's next listing sees the server's real tools.
    fn changing(_: Option<&str>) -> serde_json::Value {
        static N: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        if N.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 0 {
            serde_json::json!({ "tools": [{ "name": "old", "inputSchema": { "type": "object" } }],
                                "ttlMs": 60_000, "cacheScope": "public" })
        } else {
            serde_json::json!({ "tools": [{ "name": "new", "inputSchema": { "type": "object" } }] })
        }
    }
    let (r, seen) = connect_script(Script { list: changing, ..Script::new(Reply::Json, 0) }).await;
    let conn = r.expect("connect");
    assert_eq!(list_guarded(&conn).await.expect("first")[0].name, "old");
    let second = list_guarded(&conn).await.expect("second");
    assert_eq!(second[0].name, "new", "a cached page was served");
    assert_eq!(lists(&seen), 2, "pages requested");
}

#[tokio::test]
async fn a_list_that_fails_is_an_error_not_a_stale_page() {
    // The first page carries a 1 ms ttl; the second listing gets an error.
    // rmcp's serve_stale_on_error would hand back the expired first page.
    fn fails_second(_: Option<&str>) -> serde_json::Value {
        static N: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        if N.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 0 {
            serde_json::json!({ "tools": [{ "name": "old", "inputSchema": { "type": "object" } }], "ttlMs": 1 })
        } else {
            serde_json::json!({ "__error": { "code": -32603, "message": "listing broke" } })
        }
    }
    let (r, seen) = connect_script(Script { list: fails_second, ..Script::new(Reply::Json, 0) }).await;
    let conn = r.expect("connect");
    list_guarded(&conn).await.expect("first");
    tokio::time::sleep(Duration::from_millis(50)).await;
    let e = list_guarded(&conn).await.expect_err("a stale page was served in place of the error");
    assert!(e.contains("listing broke"), "{e}");
    assert_eq!(lists(&seen), 2, "pages requested");
}

// ---- Timeouts (M2) --------------------------------------------------------

/// The short bound the seams are driven with, and the most a test waits.
const SHORT: Duration = Duration::from_millis(500);
const GUARD: Duration = Duration::from_secs(10);

#[tokio::test]
async fn a_tools_call_the_server_never_answers_times_out() {
    let (r, seen) = connect_script(Script { hang: Some("tools/call"), ..Script::new(Reply::Json, 0) }).await;
    let conn = r.expect("connect");
    let started = Instant::now();
    let out = tokio::time::timeout(GUARD, conn.call_tool_within("wipe", serde_json::json!({}), SHORT))
        .await
        .expect("call_tool_within hung past its limit");
    let took = started.elapsed();
    let e = out.expect_err("a call nobody answered succeeded");
    assert!(e.contains("timed out after"), "{e}");
    assert!(e.contains("call_tool wipe (hostile)"), "{e}");
    assert!(took >= SHORT && took < SHORT + Duration::from_secs(3), "took {took:?}");
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(calls(&seen), 1, "tools/call sent more than once");
    // The server is told the request is abandoned (rmcp's cancel-on-drop).
    let methods = seen.lock().unwrap().methods.clone();
    assert!(methods.iter().any(|m| m == "notifications/cancelled"), "{methods:?}");
    // manager.rs reads this to drop the connection instead of reusing it.
    assert!(conn.timed_out(), "a timed-out call must mark its connection");
}

#[tokio::test]
async fn a_tools_list_the_server_never_answers_times_out() {
    let (r, _) = connect_script(Script { hang: Some("tools/list"), ..Script::new(Reply::Json, 0) }).await;
    let conn = r.expect("connect");
    let out = tokio::time::timeout(GUARD, conn.list_tools_within(SHORT))
        .await
        .expect("list_tools_within hung past its limit");
    let e = out.expect_err("a list nobody answered succeeded");
    assert!(e.contains("list_tools (hostile)") && e.contains("timed out after"), "{e}");
    assert!(conn.timed_out(), "a timed-out list must mark its connection");
}

#[tokio::test]
async fn a_server_that_never_answers_initialize_times_out() {
    let (url, seen) = fake_server(Script { hang: Some("initialize"), ..Script::new(Reply::Json, 0) }).await;
    let started = Instant::now();
    let out = tokio::time::timeout(
        GUARD,
        McpConn::connect_http_within("hostile".into(), &url, Some("tok".into()), SHORT),
    )
    .await
    .expect("connect_http_within hung past its limit");
    let took = started.elapsed();
    let e = match out {
        Err(e) => e,
        Ok(_) => panic!("connected to a server that never answered initialize"),
    };
    assert!(e.contains("mcp http handshake (hostile)") && e.contains("timed out after"), "{e}");
    assert!(took < SHORT + Duration::from_secs(3), "took {took:?}");
    assert_eq!(seen.lock().unwrap().methods, ["initialize"]);
}
