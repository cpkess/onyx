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

/** A block that references a page/tag, for inline linked references. */
export interface BlockRef {
  source_path: string;
  source_title: string;
  line_start: number;
  line_end: number;
  indent: number;
  kind: "bullet" | "task" | "para" | "heading";
  checked: boolean | null;
  block_id: string | null;
  text: string;
}

/** The resolved location of a `^block-id`. */
export interface BlockLoc {
  path: string;
  title: string;
  line_start: number;
  line_end: number;
  text: string;
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

export interface PageTask {
  text: string;
  checked: boolean;
  line: number;
  path: string;
}

export interface Page {
  path: string;
  name: string;
  folder: string;
  tags: string[];
  mtime: number;
  ctime: number;
  size: number;
  fields: Record<string, unknown>;
  tasks: PageTask[];
  outlinks: string[];
  inlinks: string[];
}

export interface AiConfig {
  base_url: string;
  chat_model: string;
  embed_model: string;
  parallel_requests: number;
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

export interface NightSettings {
  mode: "disabled" | "smart" | "scheduled" | "manual";
  window_start: number;
  window_end: number;
  idle_minutes: number;
  cpu_max: number;
  summary_apply: "append" | "note";
}

export interface NightSuggestion {
  id: number;
  kind: string;
  confidence: number;
  title: string;
  preview: string;
  body: string;
  target_path: string;
  created_at: number;
}

export interface ProcessingStatus {
  running: boolean;
  mode: string;
  pending_jobs: number;
  pending_suggestions: number;
}

export interface MorningReview {
  has_run: boolean;
  finished_at: number;
  notes_processed: number;
  links_found: number;
  summaries_created: number;
  pending_suggestions: number;
}

export interface Atom {
  id: number;
  kind: string;
  text: string;
  source_path: string;
  source_heading: string | null;
  confidence: number;
  substantiation: number;
  evidence: string | null;
  auto_approved: boolean;
  status: string;
  created_at: number;
}

export interface AtomGroup {
  source_path: string;
  source_name: string;
  atoms: Atom[];
}

export interface AtomRelationView {
  kind: string;
  direction: "in" | "out";
  atom: Atom;
}

export interface DecisionTrace {
  decision: Atom;
  supporting: Atom[];
}

export interface AtomsStatus {
  running: boolean;
  pending: number;
  approved: number;
  total: number;
}

export interface AtomsSettings {
  enabled_kinds: string[];
  infer_relationships: boolean;
  min_confidence: number;
  auto_approve: boolean;
  auto_approve_confidence: number;
  signal_min_sources: number;
}

export interface AtomFilter {
  kind?: string;
  query?: string;
  source?: string;
  relation?: string;
}

export interface NoteKnowledge {
  derived: Atom[];
  related: Atom[];
}

export interface AtomPair {
  a: Atom;
  b: Atom;
  kind: string;
}

export interface Tensions {
  contradictions: AtomPair[];
  duplicates: AtomPair[];
}

export interface AtomGraphNode {
  id: string;
  label: string;
  kind: string;
  source_path: string;
}

export interface AtomGraphEdge {
  source: string;
  target: string;
  kind: string;
}

export interface AtomGraph {
  nodes: AtomGraphNode[];
  edges: AtomGraphEdge[];
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
  renamePath: (oldPath: string, newPath: string) =>
    invoke<string>("rename_path", { old: oldPath, new: newPath }),
  resolveAsset: (currentNote: string | null, target: string) =>
    invoke<string | null>("resolve_asset", { currentNote, target }),
  saveAttachment: (name: string, data: number[], folder?: string) =>
    invoke<string>("save_attachment", { name, data, folder }),
  readVaultMeta: (name: string) =>
    invoke<string | null>("read_vault_meta", { name }),
  writeVaultMeta: (name: string, content: string) =>
    invoke<void>("write_vault_meta", { name, content }),
  deleteNote: (path: string) => invoke<void>("delete_note", { path }),
  getBacklinks: (name: string) => invoke<Backlink[]>("get_backlinks", { name }),
  getBlockBacklinks: (name: string) =>
    invoke<BlockRef[]>("get_block_backlinks", { name }),
  resolveBlockRef: (blockId: string) =>
    invoke<BlockLoc | null>("resolve_block_ref", { blockId }),
  ensureBlockId: (path: string, line: number) =>
    invoke<string>("ensure_block_id", { path, line }),
  atomsForPage: (page: string) => invoke<Atom[]>("atoms_for_page", { page }),
  searchNotes: (query: string) =>
    invoke<SearchResult[]>("search_notes", { query }),
  getNoteNames: () => invoke<string[]>("get_note_names"),
  getTags: () => invoke<[string, number][]>("get_tags"),
  getNotesByTag: (tag: string) => invoke<string[]>("get_notes_by_tag", { tag }),
  getUnlinkedMentions: (name: string) =>
    invoke<SearchResult[]>("get_unlinked_mentions", { name }),
  getGraph: () => invoke<GraphData>("get_graph"),
  getPages: () => invoke<Page[]>("get_pages"),
  toggleTask: (path: string, line: number) =>
    invoke<void>("toggle_task", { path, line }),
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
  aiIndexNote: (path: string) => invoke<boolean>("ai_index_note", { path }),
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
  aiRegenerate: (path: string) =>
    invoke<AiDocument>("ai_regenerate", { path }),
  aiComposeSections: (path: string) =>
    invoke<AiDocument>("ai_compose_sections", { path }),
  aiRagChat: (messages: ChatMessage[], requestId: string) =>
    invoke<void>("ai_rag_chat", { messages, requestId }),
  aiComplete: (messages: ChatMessage[]) =>
    invoke<string>("ai_complete", { messages }),
  appendToNote: (path: string, heading: string, text: string) =>
    invoke<void>("append_to_note", { path, heading, text }),
  importDocument: (filePath: string, useLlm = true) =>
    invoke<string>("import_document", { filePath, useLlm }),
  importDocumentBytes: (name: string, data: number[], useLlm = true) =>
    invoke<string>("import_document_bytes", { name, data, useLlm }),

  // ---- Night Shift (overnight intelligence) ----
  recordEvent: (kind: string, entity?: string, metadata?: string) =>
    invoke<void>("record_event", { kind, entity, metadata }),
  getNightSettings: () => invoke<NightSettings>("get_night_settings"),
  setNightSettings: (settings: NightSettings) =>
    invoke<void>("set_night_settings", { settings }),
  getProcessingStatus: () => invoke<ProcessingStatus>("get_processing_status"),
  startProcessing: () => invoke<void>("start_processing"),
  pauseProcessing: () => invoke<void>("pause_processing"),
  getSuggestions: () => invoke<NightSuggestion[]>("get_suggestions"),
  getMorningReview: () => invoke<MorningReview>("get_morning_review"),
  acceptSuggestion: (id: number) => invoke<string>("accept_suggestion", { id }),
  dismissSuggestion: (id: number, never: boolean) =>
    invoke<void>("dismiss_suggestion", { id, never }),

  // ---- Atomic Knowledge Synthesis ----
  atomsGetSettings: () => invoke<AtomsSettings>("atoms_get_settings"),
  atomsSetSettings: (settings: AtomsSettings) =>
    invoke<void>("atoms_set_settings", { settings }),
  atomsStatus: () => invoke<AtomsStatus>("atoms_status"),
  atomsSynthesizeNote: (path: string) => invoke<void>("atoms_synthesize_note", { path }),
  atomsSynthesizeVault: () => invoke<void>("atoms_synthesize_vault"),
  atomsRebuild: () => invoke<void>("atoms_rebuild"),
  getPendingAtoms: () => invoke<AtomGroup[]>("get_pending_atoms"),
  getAtoms: (filter: AtomFilter) => invoke<Atom[]>("get_atoms", { filter }),
  approveAtom: (id: number) => invoke<void>("approve_atom", { id }),
  atomsApproveAll: () => invoke<number>("atoms_approve_all"),
  rejectAtom: (id: number) => invoke<void>("reject_atom", { id }),
  editAtom: (id: number, text: string, kind: string) =>
    invoke<void>("edit_atom", { id, text, kind }),
  mergeAtoms: (ids: number[], text: string, kind: string) =>
    invoke<number>("merge_atoms", { ids, text, kind }),
  splitAtom: (id: number, texts: string[]) => invoke<void>("split_atom", { id, texts }),
  getRelations: (atomId: number) => invoke<AtomRelationView[]>("get_relations", { atomId }),
  getDecisionTrace: (atomId: number) =>
    invoke<DecisionTrace | null>("get_decision_trace", { atomId }),
  getDecisions: () => invoke<Atom[]>("get_decisions"),
  getNoteKnowledge: (path: string) => invoke<NoteKnowledge>("get_note_knowledge", { path }),
  getTensions: () => invoke<Tensions>("get_tensions"),
  getAtomGraph: () => invoke<AtomGraph>("get_atom_graph"),
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
