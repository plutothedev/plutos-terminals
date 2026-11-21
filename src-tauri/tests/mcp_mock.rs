use std::time::{Duration, Instant};

use app_lib::mcp::client::McpConn;

const FIXTURE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/mock_mcp_server.mjs");

#[tokio::test]
async fn connects_lists_and_calls_mock_server() {
    let conn = McpConn::connect_stdio("mock".into(), "node", &[FIXTURE.to_string()], &Default::default())
        .await
        .expect("connect mock (needs node on PATH)");
    let tools = conn.list_tools().await.expect("list");
    assert_eq!(tools.len(), 1);
    assert_eq!(tools[0].name, "echo");
    assert!(tools[0].read_only);
    assert!(!tools[0].destructive);
    let out = conn
        .call_tool("echo", serde_json::json!({"hi": 1}))
        .await
        .expect("call");
    let s = serde_json::to_string(&out).unwrap();
    assert!(s.contains("hi"));
}

// The handshake and call timeouts over stdio, through the `_within` seams with
// short durations (real child process, real clock).
const SHORT: Duration = Duration::from_millis(500);
const GUARD: Duration = Duration::from_secs(15);

#[tokio::test]
async fn a_stdio_server_that_never_answers_initialize_times_out() {
    // Reads stdin for ever and writes nothing.
    let args = ["-e".to_string(), "process.stdin.resume()".to_string()];
    let started = Instant::now();
    let out = tokio::time::timeout(
        GUARD,
        McpConn::connect_stdio_within("mute".into(), "node", &args, &Default::default(), SHORT),
    )
    .await
    .expect("connect_stdio_within hung past its limit (needs node on PATH)");
    let took = started.elapsed();
    let e = match out {
        Err(e) => e,
        Ok(_) => panic!("connected to a server that never answered initialize"),
    };
    assert!(e.contains("mcp stdio handshake (mute)") && e.contains("timed out after"), "{e}");
    assert!(took < SHORT + Duration::from_secs(5), "took {took:?}");
}

#[tokio::test]
async fn a_stdio_tools_call_that_never_returns_times_out() {
    let args = [FIXTURE.to_string(), "--hang-call".to_string()];
    let conn = McpConn::connect_stdio("mock".into(), "node", &args, &Default::default())
        .await
        .expect("connect mock (needs node on PATH)");
    let out = tokio::time::timeout(GUARD, conn.call_tool_within("echo", serde_json::json!({}), SHORT))
        .await
        .expect("call_tool_within hung past its limit");
    let e = out.expect_err("a call nobody answered succeeded");
    assert!(e.contains("call_tool echo (mock)") && e.contains("timed out after"), "{e}");
}
