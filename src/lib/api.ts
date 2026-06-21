import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";

export interface TreeNode {
  name: string;
  path: string;
  is_dir: boolean;
  children: TreeNode[];
}

export interface VaultInfo {
  root: string;
  name: string;
  tree: TreeNode[];
  note_count: number;
}

export interface Backlink {
  path: string;
  title: string;
  snippet: string;
}

export interface SearchResult {
  path: string;
  title: string;
  snippet: string;
}

export interface GraphNode {
  id: string;
  label: string;
}

export interface GraphEdge {
  source: string;
  target: string;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface AiConfig {
  base_url: string;
  chat_model: string;
  embed_model: string;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface SemanticHit {
  path: string;
  chunk_index: number;
  text: string;
  distance: number;
}

export interface LinkSuggestion {
  name: string;
  path: string;
  reason: string;
}

export interface AiDocument {
  title: string;
  content: string;
}

export const api = {
  getLastVault: () => invoke<string | null>("get_last_vault"),
  openVault: (path: string) => invoke<VaultInfo>("open_vault", { path }),
  getTree: () => invoke<TreeNode[]>("get_tree"),
  readNote: (path: string) => invoke<string>("read_note", { path }),
  writeNote: (path: string, content: string) =>
    invoke<void>("write_note", { path, content }),
  createNote: (path: string) => invoke<string>("create_note", { path }),
  createFolder: (path: string) => invoke<string>("create_folder", { path }),
  movePath: (src: string, destDir: string) =>
    invoke<string>("move_path", { src, destDir }),
  resolveAsset: (currentNote: string | null, target: string) =>
    invoke<string | null>("resolve_asset", { currentNote, target }),
  deleteNote: (path: string) => invoke<void>("delete_note", { path }),
  getBacklinks: (name: string) => invoke<Backlink[]>("get_backlinks", { name }),
  searchNotes: (query: string) =>
    invoke<SearchResult[]>("search_notes", { query }),
  getNoteNames: () => invoke<string[]>("get_note_names"),
  getGraph: () => invoke<GraphData>("get_graph"),
  reindex: () => invoke<number>("reindex"),
  resolveLink: (name: string) =>
    invoke<string | null>("resolve_link", { name }),

  // ---- AI / LM Studio ----
  aiGetConfig: () => invoke<AiConfig>("ai_get_config"),
  aiSetConfig: (config: AiConfig) => invoke<void>("ai_set_config", { config }),
  aiListModels: (baseUrl: string) =>
    invoke<string[]>("ai_list_models", { baseUrl }),
  aiChat: (messages: ChatMessage[], requestId: string) =>
    invoke<void>("ai_chat", { messages, requestId }),
  aiIndexStatus: () => invoke<number>("ai_index_status"),
  aiIndexVault: () => invoke<number>("ai_index_vault"),
  aiSemanticSearch: (query: string, k: number) =>
    invoke<SemanticHit[]>("ai_semantic_search", { query, k }),

  // ---- Phase 3 AI features ----
  createNoteWithContent: (path: string, content: string) =>
    invoke<string>("create_note_with_content", { path, content }),
  aiSuggestTags: (path: string) =>
    invoke<string[]>("ai_suggest_tags", { path }),
  aiSuggestLinks: (path: string) =>
    invoke<LinkSuggestion[]>("ai_suggest_links", { path }),
  aiSynthesize: (scopeKind: string, scopeValue: string) =>
    invoke<AiDocument>("ai_synthesize", { scopeKind, scopeValue }),
  aiSubjectPage: (subject: string) =>
    invoke<AiDocument>("ai_subject_page", { subject }),
  aiRagChat: (messages: ChatMessage[], requestId: string) =>
    invoke<void>("ai_rag_chat", { messages, requestId }),
};

/** Open a native folder picker; returns the chosen path or null. */
export async function pickVaultFolder(): Promise<string | null> {
  const result = await openDialog({ directory: true, multiple: false });
  return typeof result === "string" ? result : null;
}

/** The wikilink "name" (file stem) for a vault-relative path. */
export function noteName(path: string): string {
  const file = path.split("/").pop() ?? path;
  return file.replace(/\.md$/i, "");
}
