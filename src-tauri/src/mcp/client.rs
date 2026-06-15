// (C) MCP connection wrapper — a thin, stable adapter over the official `rmcp`
// SDK. The rest of the app talks to `McpConn` (connect / list_tools / call_tool)
// and our own `Tool` struct; rmcp owns the protocol, handshake, and transports.
//
// SAFETY-CRITICAL annotation mapping (see manager.rs / the agent approval gate):
//   read_only   = annotations.read_only_hint == Some(true), else false
//   destructive = annotations.destructive_hint when present, else !read_only
//                 (unannotated tools are treated as destructive unless the server
//                  explicitly marked them read-only — fail safe).
use std::collections::BTreeMap;

use rmcp::model::{CallToolRequestParams, Tool as RmcpTool};
use rmcp::service::{RoleClient, RunningService};
use rmcp::transport::streamable_http_client::StreamableHttpClientTransportConfig;
use rmcp::transport::{StreamableHttpClientTransport, TokioChildProcess};
use rmcp::ServiceExt;

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
}

/// A live connection to a single MCP server. Holds the running rmcp client; the
/// server stays connected until this is dropped.
pub struct McpConn {
    server_id: String,
    client: RunningService<RoleClient, ()>,
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
        let mut cmd = tokio::process::Command::new(command);
        cmd.args(args);
        for (k, v) in env {
            cmd.env(k, v);
        }
        let transport = TokioChildProcess::new(cmd).map_err(|e| format!("spawn {command}: {e}"))?;
        let client = ()
            .serve(transport)
            .await
            .map_err(|e| format!("mcp stdio handshake ({server_id}): {e}"))?;
        Ok(McpConn { server_id, client })
    }

    /// Connect to a streamable-HTTP MCP server, optionally with a bearer token.
    pub async fn connect_http(
        server_id: String,
        url: &str,
        bearer: Option<String>,
    ) -> Result<McpConn, String> {
        // `auth_header` wants the raw bearer token (no "Bearer " prefix); rmcp's
        // default reqwest-backed client carries it. Using `from_config` (rather
        // than a custom reqwest::Client) sidesteps the reqwest-version skew
        // between rmcp's transport and the app's own reqwest dependency.
        let config = StreamableHttpClientTransportConfig::with_uri(url.to_string());
        let config = match bearer {
            Some(token) => config.auth_header(token),
            None => config,
        };
        let transport = StreamableHttpClientTransport::from_config(config);
        let client = ()
            .serve(transport)
            .await
            .map_err(|e| format!("mcp http handshake ({server_id}): {e}"))?;
        Ok(McpConn { server_id, client })
    }

    /// List every tool the server advertises, normalized to our `Tool`.
    pub async fn list_tools(&self) -> Result<Vec<Tool>, String> {
        let tools = self
            .client
            .list_all_tools()
            .await
            .map_err(|e| format!("list_tools ({}): {e}", self.server_id))?;
        Ok(tools.into_iter().map(|t| self.map_tool(t)).collect())
    }

    /// Invoke a tool. `args` should be a JSON object (other shapes pass no
    /// arguments). Returns the full CallToolResult serialized to JSON.
    pub async fn call_tool(
        &self,
        name: &str,
        args: serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        let mut params = CallToolRequestParams::new(name.to_string());
        if let serde_json::Value::Object(map) = args {
            params = params.with_arguments(map);
        }
        let result = self
            .client
            .call_tool(params)
            .await
            .map_err(|e| format!("call_tool {name} ({}): {e}", self.server_id))?;
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
        }
    }
}
