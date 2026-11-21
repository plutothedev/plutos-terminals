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

/// How long a test waits for a pid file. A cold `node` start on a loaded
/// machine has taken more than 3 s; a warm one writes the file at once.
const PID_FILE_WAIT: Duration = Duration::from_secs(15);

/// Poll for a pid file until it has content or PID_FILE_WAIT passes.
async fn read_pid_file(path: &std::path::Path) -> Option<String> {
    let deadline = Instant::now() + PID_FILE_WAIT;
    loop {
        if let Ok(text) = std::fs::read_to_string(path) {
            if !text.trim().is_empty() {
                return Some(text);
            }
        }
        if Instant::now() >= deadline {
            return None;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// Poll until `pid` is gone or `within` passes; whether it is still alive.
async fn alive_after(pid: u32, within: Duration) -> bool {
    let deadline = Instant::now() + within;
    while alive(pid) && Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    alive(pid)
}

/// A fresh pid file path for one test (several run at once).
fn pid_path(tag: &str) -> std::path::PathBuf {
    let path = std::env::temp_dir().join(format!("mcp-{tag}-{}.pid", std::process::id()));
    let _ = std::fs::remove_file(&path);
    path
}

/// The shell launcher that runs `node <args>` as its own child: `cmd /c` on
/// Windows, `sh -c` elsewhere, the shape of a server started by `cmd /c`,
/// `npx` or `uvx`. The shell is the app's direct child, node the grandchild.
fn through_a_shell(node_args: &[String]) -> (&'static str, Vec<String>) {
    #[cfg(windows)]
    {
        let mut args = vec!["/c".to_string(), "node".to_string()];
        args.extend(node_args.iter().cloned());
        ("cmd", args)
    }
    #[cfg(unix)]
    {
        let mut args = vec!["-c".to_string(), "node \"$@\"; true".to_string(), "sh".to_string()];
        args.extend(node_args.iter().cloned());
        ("sh", args)
    }
}

#[tokio::test]
async fn a_launcher_dropped_mid_handshake_takes_its_child_server_with_it() {
    // A handshake that runs out of time drops the transport, and so does an
    // eviction; the whole process tree must go, not only the launcher. The
    // handshake future is dropped here as soon as the server is up, which is
    // exactly what its timeout does on expiry (tokio::time::timeout drops the
    // future it wraps), so a cold node start cannot outlast a short bound and
    // a warm one does not wait out a long one.
    let server = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/silent_server_pid.mjs");
    let pid_file = pid_path("grandchild");
    let (launcher, args) = through_a_shell(&[server.to_string(), pid_file.to_string_lossy().into_owned()]);
    let env = std::collections::BTreeMap::new();
    // Boxed, not tokio::pin!ed: dropping a pinned reference would leave the
    // future, and the transport it owns, alive to the end of the scope.
    let mut connect = Box::pin(McpConn::connect_stdio_within("launcher".into(), launcher, &args, &env, PID_FILE_WAIT));
    let pid = tokio::select! {
        out = &mut connect => {
            assert!(out.is_err(), "the launcher never answers initialize");
            read_pid_file(&pid_file).await
        }
        pid = read_pid_file(&pid_file) => pid,
    };
    drop(connect);
    let pid: u32 = pid.expect("the launcher never started its child (needs node on PATH)").trim().parse().unwrap();
    let _ = std::fs::remove_file(&pid_file);
    // The kill runs on a spawned task after the drop; give it a moment.
    let survived = alive_after(pid, Duration::from_secs(10)).await;
    kill(pid);
    assert!(!survived, "the launcher's child server (pid {pid}) outlived the dropped connection");
}

#[tokio::test]
async fn a_hung_server_behind_a_launcher_dies_with_its_tree_when_dropped() {
    // A live connection whose server stopped answering (a call ran out of
    // time) and does not exit when its stdin closes: dropping it, as an
    // eviction does, waits out rmcp's grace period and then kills the whole
    // tree, the real server behind the launcher included.
    let pid_file = pid_path("hung");
    let (launcher, args) = through_a_shell(&[
        FIXTURE.to_string(),
        "--hang-call".into(),
        "--ignore-eof".into(),
        "--pid-file".into(),
        pid_file.to_string_lossy().into_owned(),
    ]);
    let conn = tokio::time::timeout(
        GUARD,
        McpConn::connect_stdio_within("hung".into(), launcher, &args, &Default::default(), PID_FILE_WAIT),
    )
    .await
    .expect("connect hung past its limit")
    .expect("connect the mock through a launcher (needs node on PATH)");
    let pid: u32 = read_pid_file(&pid_file).await.expect("the server wrote no pid").trim().parse().unwrap();
    let _ = std::fs::remove_file(&pid_file);
    let e = conn.call_tool_within("echo", serde_json::json!({}), SHORT).await.expect_err("a hung call answered");
    assert!(e.contains("timed out after"), "{e}");
    assert!(conn.unusable());
    drop(conn);
    // rmcp drains for up to 2 s, closes stdin, waits up to 3 s, then kills.
    let survived = alive_after(pid, GUARD).await;
    kill(pid);
    assert!(!survived, "the hung server (pid {pid}) behind the launcher outlived its dropped connection");
}

#[tokio::test]
async fn a_server_that_exits_on_close_leaves_what_it_launched_running() {
    // A tool opened something of its own (a browser, an editor). Closing the
    // connection normally closes the server's stdin and it exits by itself;
    // nothing it launched is killed, as before v0.7.6. Only a server that
    // does not exit is killed, tree and all (the test above).
    let pid_file = pid_path("spawner");
    let args = [FIXTURE.to_string(), "--spawn-child".into(), pid_file.to_string_lossy().into_owned()];
    let conn = McpConn::connect_stdio("spawner".into(), "node", &args, &Default::default())
        .await
        .expect("connect mock (needs node on PATH)");
    let pids = read_pid_file(&pid_file).await.expect("the server wrote no pids");
    let _ = std::fs::remove_file(&pid_file);
    let mut pids = pids.split_whitespace().map(|p| p.parse::<u32>().unwrap());
    let (server, child) = (pids.next().unwrap(), pids.next().unwrap());
    assert!(alive(child), "the server's own process never started");
    drop(conn);
    let server_lived = alive_after(server, GUARD).await;
    // The server is gone; give a kill that follows its exit (a job closed
    // with kill-on-close) time to land before looking at what it launched.
    tokio::time::sleep(Duration::from_millis(1500)).await;
    let child_lived = alive(child);
    kill(server);
    kill(child);
    assert!(!server_lived, "the server did not exit when its stdin closed");
    assert!(child_lived, "closing the connection killed a process the server launched (pid {child})");
}
