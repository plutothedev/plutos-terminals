use app_lib::mcp::client::McpConn;

#[tokio::test]
async fn connects_lists_and_calls_mock_server() {
    let fixture = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/mock_mcp_server.mjs");
    let conn = McpConn::connect_stdio("mock".into(), "node", &[fixture.to_string()], &Default::default())
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
