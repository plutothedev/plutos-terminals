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
        // A token goes only where the app sends API keys: https, or plain http
        // to localhost / a private-LAN address (llm::resolve_base's rule).
        if bearer.is_some() && crate::llm::resolve_base(url, url).is_err() {
            return Err(format!(
                "mcp ({server_id}): refusing to send the token to a non-HTTPS address. Use https:// (http:// is allowed only for localhost or a private-LAN address)."
            ));
        }
        // `auth_header` wants the raw bearer token (no "Bearer " prefix).
        let config = StreamableHttpClientTransportConfig::with_uri(url.to_string());
        let config = match bearer {
            Some(token) => config.auth_header(token),
            None => config,
        };
        let http = mcp_http_client().map_err(|e| format!("mcp http client ({server_id}): {e}"))?;
        let transport = StreamableHttpClientTransport::with_client(http, config);
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
        let start = src.find("pub async fn connect_http(").unwrap();
        let body = &src[start..start + src[start..].find("\n    }\n").unwrap()];
        assert!(body.contains("let http = mcp_http_client()"), "{body}");
        assert!(body.contains("StreamableHttpClientTransport::with_client(http, config)"), "{body}");
        assert!(!body.contains("from_config"), "{body}");
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
