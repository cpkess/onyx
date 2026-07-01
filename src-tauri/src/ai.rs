//! LM Studio client: configuration plus the OpenAI-compatible endpoints we use
//! (`/models`, `/embeddings`, streaming `/chat/completions`).
//! LM Studio defaults to `http://localhost:1234/v1`.

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, Manager};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AiConfig {
    pub base_url: String,
    pub chat_model: String,
    pub embed_model: String,
    /// How many LLM requests to run concurrently for batch work (extraction,
    /// import). Clamped to 1–8 by callers.
    #[serde(default = "default_parallel")]
    pub parallel_requests: usize,
}

fn default_parallel() -> usize {
    4
}

impl Default for AiConfig {
    fn default() -> Self {
        Self {
            base_url: "http://localhost:1234/v1".to_string(),
            chat_model: String::new(),
            embed_model: String::new(),
            parallel_requests: 4,
        }
    }
}

fn config_file(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_config_dir().ok()?;
    let _ = std::fs::create_dir_all(&dir);
    Some(dir.join("onyx-ai.json"))
}

pub fn load_config(app: &AppHandle) -> AiConfig {
    config_file(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub fn save_config(app: &AppHandle, cfg: &AiConfig) {
    if let Some(path) = config_file(app) {
        if let Ok(data) = serde_json::to_string_pretty(cfg) {
            let _ = std::fs::write(path, data);
        }
    }
}

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
}

fn join(base: &str, path: &str) -> String {
    format!("{}/{}", base.trim_end_matches('/'), path.trim_start_matches('/'))
}

// ---- /models ----

#[derive(Deserialize)]
struct ModelsResponse {
    data: Vec<ModelEntry>,
}
#[derive(Deserialize)]
struct ModelEntry {
    id: String,
}

/// List model ids currently available in LM Studio.
pub async fn list_models(base_url: &str) -> Result<Vec<String>, String> {
    let url = join(base_url, "models");
    let resp = client()
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Request failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("LM Studio returned HTTP {}", resp.status()));
    }
    let parsed: ModelsResponse = resp
        .json()
        .await
        .map_err(|e| format!("Bad /models response: {e}"))?;
    Ok(parsed.data.into_iter().map(|m| m.id).collect())
}

// ---- /embeddings ----

#[derive(Serialize)]
struct EmbeddingsRequest<'a> {
    model: &'a str,
    input: Vec<String>,
}
#[derive(Deserialize)]
struct EmbeddingsResponse {
    data: Vec<EmbeddingEntry>,
}
#[derive(Deserialize)]
struct EmbeddingEntry {
    embedding: Vec<f32>,
    #[serde(default)]
    index: usize,
}

/// Embed a batch of texts. Returns one vector per input, in input order.
pub async fn embed(cfg: &AiConfig, inputs: Vec<String>) -> Result<Vec<Vec<f32>>, String> {
    if cfg.embed_model.is_empty() {
        return Err("No embedding model configured (set one in Settings).".into());
    }
    if inputs.is_empty() {
        return Ok(vec![]);
    }
    let url = join(&cfg.base_url, "embeddings");
    let body = EmbeddingsRequest {
        model: &cfg.embed_model,
        input: inputs,
    };
    let resp = client()
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Request failed: {e}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("Embeddings HTTP {status}: {text}"));
    }
    let mut parsed: EmbeddingsResponse = resp
        .json()
        .await
        .map_err(|e| format!("Bad /embeddings response: {e}"))?;
    // Restore input order by the returned index.
    parsed.data.sort_by_key(|e| e.index);
    Ok(parsed.data.into_iter().map(|e| e.embedding).collect())
}

// ---- /chat/completions (streaming) ----

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

#[derive(Serialize)]
struct ChatRequest<'a> {
    model: &'a str,
    messages: &'a [ChatMessage],
    stream: bool,
}

#[derive(Deserialize)]
struct ChatCompletion {
    choices: Vec<ChatChoice>,
}
#[derive(Deserialize)]
struct ChatChoice {
    message: ChatMessage,
}

/// Non-streaming chat completion — returns the full assistant text. Used for
/// structured outputs (tags, link suggestions, synthesis) that we parse.
pub async fn chat_complete(cfg: &AiConfig, messages: Vec<ChatMessage>) -> Result<String, String> {
    if cfg.chat_model.is_empty() {
        return Err("No chat model configured (set one in Settings).".into());
    }
    let url = join(&cfg.base_url, "chat/completions");
    let body = ChatRequest {
        model: &cfg.chat_model,
        messages: &messages,
        stream: false,
    };
    let resp = client()
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Request failed: {e}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("Chat HTTP {status}: {text}"));
    }
    let parsed: ChatCompletion = resp
        .json()
        .await
        .map_err(|e| format!("Bad chat response: {e}"))?;
    parsed
        .choices
        .into_iter()
        .next()
        .map(|c| c.message.content)
        .ok_or_else(|| "Empty chat response".into())
}

#[derive(Serialize, Clone)]
struct TokenEvent {
    id: String,
    delta: String,
}
#[derive(Serialize, Clone)]
struct DoneEvent {
    id: String,
}
#[derive(Serialize, Clone)]
struct ErrorEvent {
    id: String,
    error: String,
}

/// Stream a chat completion, emitting `ai-chat:token` / `ai-chat:done` /
/// `ai-chat:error` events tagged with `request_id`.
pub async fn chat_stream(
    app: AppHandle,
    cfg: AiConfig,
    messages: Vec<ChatMessage>,
    request_id: String,
) {
    if cfg.chat_model.is_empty() {
        let _ = app.emit(
            "ai-chat:error",
            ErrorEvent {
                id: request_id,
                error: "No chat model configured (set one in Settings).".into(),
            },
        );
        return;
    }

    let url = join(&cfg.base_url, "chat/completions");
    let body = ChatRequest {
        model: &cfg.chat_model,
        messages: &messages,
        stream: true,
    };

    let resp = match client().post(&url).json(&body).send().await {
        Ok(r) => r,
        Err(e) => {
            let _ = app.emit(
                "ai-chat:error",
                ErrorEvent {
                    id: request_id,
                    error: format!("Request failed: {e}"),
                },
            );
            return;
        }
    };

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        let _ = app.emit(
            "ai-chat:error",
            ErrorEvent {
                id: request_id,
                error: format!("Chat HTTP {status}: {text}"),
            },
        );
        return;
    }

    let mut stream = resp.bytes_stream();
    let mut buffer = String::new();

    while let Some(chunk) = stream.next().await {
        let bytes = match chunk {
            Ok(b) => b,
            Err(e) => {
                let _ = app.emit(
                    "ai-chat:error",
                    ErrorEvent {
                        id: request_id.clone(),
                        error: format!("Stream error: {e}"),
                    },
                );
                return;
            }
        };
        buffer.push_str(&String::from_utf8_lossy(&bytes));

        // Process complete SSE lines.
        while let Some(nl) = buffer.find('\n') {
            let line = buffer[..nl].trim().to_string();
            buffer.drain(..=nl);
            let Some(data) = line.strip_prefix("data:") else {
                continue;
            };
            let data = data.trim();
            if data == "[DONE]" {
                let _ = app.emit("ai-chat:done", DoneEvent { id: request_id.clone() });
                return;
            }
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(data) {
                if let Some(delta) = json["choices"][0]["delta"]["content"].as_str() {
                    if !delta.is_empty() {
                        let _ = app.emit(
                            "ai-chat:token",
                            TokenEvent {
                                id: request_id.clone(),
                                delta: delta.to_string(),
                            },
                        );
                    }
                }
            }
        }
    }

    let _ = app.emit("ai-chat:done", DoneEvent { id: request_id });
}
