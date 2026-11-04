//! Outbound connectivity. The agent connects out to the server and never listens. Only the target
//! address is defined so far; connecting arrives together with pairing.

use url::Url;

pub const AGENT_WS_PATH: &str = "/api/v1/agent/ws";

/// WebSocket address of the agent endpoint for a server's base URL. A base path is preserved, so
/// that a server behind a reverse proxy prefix works.
pub fn agent_ws_url(api_url: &Url) -> Url {
    let mut url = api_url.clone();
    // Cannot fail for http and https, the only schemes configuration accepts.
    let scheme = if api_url.scheme() == "https" {
        "wss"
    } else {
        "ws"
    };
    let _ = url.set_scheme(scheme);
    let base = api_url.path().trim_end_matches('/');
    url.set_path(&format!("{base}{AGENT_WS_PATH}"));
    url
}
