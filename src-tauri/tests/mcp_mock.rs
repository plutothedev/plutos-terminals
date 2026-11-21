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

#[tokio::test]
async fn a_stdio_list_the_server_marked_cacheable_is_still_reread() {
    // The first listing says it stays fresh for a minute (ttlMs); the next
    // lists a different tool. rmcp 3.11's response cache would serve the first.
    let args = [FIXTURE.to_string(), "--list-changes".to_string()];
    let conn = McpConn::connect_stdio("mock".into(), "node", &args, &Default::default())
        .await
        .expect("connect mock (needs node on PATH)");
    assert_eq!(conn.list_tools().await.expect("first")[0].name, "echo");
    assert_eq!(conn.list_tools().await.expect("second")[0].name, "echo2", "a cached page was served");
}

#[tokio::test]
async fn a_server_that_exits_mid_session_marks_its_connection() {
    // The child exits when the call arrives. The connection is dead for good,
    // so manager.rs must drop it and reconnect instead of failing every call.
    let args = [FIXTURE.to_string(), "--exit-on-call".to_string()];
    let conn = McpConn::connect_stdio("mock".into(), "node", &args, &Default::default())
        .await
        .expect("connect mock (needs node on PATH)");
    assert!(!conn.unusable(), "a fresh connection is usable");
    let out = tokio::time::timeout(GUARD, conn.call_tool("echo", serde_json::json!({})))
        .await
        .expect("call_tool hung on a server that exited");
    out.expect_err("a call to a server that exited succeeded");
    assert!(conn.unusable(), "a connection whose server exited still looks usable");
    assert!(!conn.timed_out(), "it closed, it did not time out");
}

/// Whether a process with this pid is still running.
fn alive(pid: u32) -> bool {
    #[cfg(windows)]
    {
        let out = std::process::Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/NH", "/FO", "CSV"])
            .output()
            .expect("tasklist");
        String::from_utf8_lossy(&out.stdout).contains(&format!("\"{pid}\""))
    }
    #[cfg(unix)]
    {
        std::process::Command::new("kill")
            .args(["-0", &pid.to_string()])
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }
}

fn kill(pid: u32) {
    #[cfg(windows)]
    let _ = std::process::Command::new("taskkill").args(["/PID", &pid.to_string(), "/F"]).output();
    #[cfg(unix)]
    let _ = std::process::Command::new("kill").args(["-9", &pid.to_string()]).output();
}

#[tokio::test]
async fn a_launcher_that_times_out_takes_its_child_server_with_it() {
    // npx, uvx and `cmd /c` start the real server as a child of their own.
    // A handshake timeout (or an eviction) drops the transport; the whole
    // process tree must go, not only the launcher.
    let server = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/silent_server_pid.mjs");
    let pid_file = std::env::temp_dir().join(format!("mcp-grandchild-{}.pid", std::process::id()));
    let _ = std::fs::remove_file(&pid_file);
    let pid_path = pid_file.to_string_lossy().into_owned();
    // The shell is the direct child and the node server its child.
    #[cfg(windows)]
    let (launcher, args) = ("cmd", ["/c".to_string(), "node".into(), server.into(), pid_path]);
    #[cfg(unix)]
    let (launcher, args) = ("sh", ["-c".to_string(), "node \"$0\" \"$1\"; true".into(), server.into(), pid_path]);
    let out = tokio::time::timeout(
        GUARD,
        McpConn::connect_stdio_within("launcher".into(), launcher, &args, &Default::default(), Duration::from_secs(3)),
    )
    .await
    .expect("connect_stdio_within hung past its limit (needs node on PATH)");
    assert!(out.is_err(), "the launcher never answers initialize");
    let pid: u32 = std::fs::read_to_string(&pid_file)
        .expect("the launcher never started its child")
        .trim()
        .parse()
        .unwrap();
    let _ = std::fs::remove_file(&pid_file);
    // The kill runs on a spawned task after the drop; give it a moment.
    let deadline = Instant::now() + Duration::from_secs(5);
    while alive(pid) && Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let survived = alive(pid);
    kill(pid);
    assert!(!survived, "the launcher's child server (pid {pid}) outlived the timed-out connection");
}
