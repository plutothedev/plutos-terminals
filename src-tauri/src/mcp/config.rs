// (C)
// App-managed MCP server config, persisted to <app_data>/mcp-servers.json.
// Secrets (HTTP tokens, sensitive env) are NOT stored here — only the keychain
// account key names in `secret_keys`; values live in the OS keychain (vault.rs).
use std::collections::BTreeMap;
use std::path::Path;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct ServerCfg {
    pub id: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    pub transport: String,             // "stdio" | "http"
    #[serde(default)]
    pub command: Option<String>,       // stdio
    #[serde(default)]
    pub args: Vec<String>,             // stdio
    #[serde(default)]
    pub env: BTreeMap<String, String>, // stdio non-secret env
    #[serde(default)]
    pub url: Option<String>,           // http
    #[serde(default)]
    pub secret_keys: Vec<String>,      // keychain key names (env name, or "bearer")
}
fn default_true() -> bool { true }

pub fn load_configs(path: &Path) -> Result<Vec<ServerCfg>, String> {
    match std::fs::read_to_string(path) {
        Ok(s) => serde_json::from_str(&s).map_err(|e| e.to_string()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(vec![]),
        Err(e) => Err(e.to_string()),
    }
}

pub fn save_configs(path: &Path, cfgs: &[ServerCfg]) -> Result<(), String> {
    if let Some(parent) = path.parent() { std::fs::create_dir_all(parent).map_err(|e| e.to_string())?; }
    let json = serde_json::to_string_pretty(cfgs).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn round_trips_config_json() {
        let dir = std::env::temp_dir().join(format!("mcp-cfg-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("mcp-servers.json");
        let cfgs = vec![ServerCfg {
            id: "fs".into(), enabled: true, transport: "stdio".into(),
            command: Some("npx".into()),
            args: vec!["-y".into(), "server-filesystem".into()],
            env: Default::default(), url: None, secret_keys: vec![],
        }];
        save_configs(&path, &cfgs).unwrap();
        let back = load_configs(&path).unwrap();
        assert_eq!(back.len(), 1);
        assert_eq!(back[0].id, "fs");
        assert_eq!(back[0].args, vec!["-y", "server-filesystem"]);
        let _ = std::fs::remove_dir_all(&dir);
    }
    #[test]
    fn missing_file_is_empty_list() {
        let p = std::env::temp_dir().join("does-not-exist-mcp-xyz.json");
        let _ = std::fs::remove_file(&p);
        assert!(load_configs(&p).unwrap().is_empty());
    }
}
