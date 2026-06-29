# Onyx

**An AI-augmented, local-first knowledge base for macOS.**

Onyx is a Markdown note-taking app inspired by [Obsidian](https://obsidian.md), built natively for the Mac. Your notes are plain `.md` files in a folder you own — no cloud, no lock-in. On top of that foundation Onyx adds a live-preview editor, a linked knowledge graph, Dataview-style queries, and a deep suite of **local AI** features powered by [LM Studio](https://lmstudio.ai) running entirely on your machine.

> ⬇️ **[Download the latest release](https://github.com/cpkess/onyx/releases/latest)** — signed & notarized, opens with no Gatekeeper warning. Apple Silicon (arm64).

---

## Table of contents

- [Highlights](#highlights)
- [Features](#features)
  - [Editor & Markdown](#editor--markdown)
  - [Linking & knowledge graph](#linking--knowledge-graph)
  - [Dataview-style queries](#dataview-style-queries)
  - [Daily notes & calendar](#daily-notes--calendar)
  - [Panes & navigation](#panes--navigation)
  - [Templates & bookmarks](#templates--bookmarks)
  - [AI features (local, via LM Studio)](#ai-features-local-via-lm-studio)
  - [Document ingestion](#document-ingestion)
  - [Local-first storage](#local-first-storage)
  - [Auto-updates](#auto-updates)
- [Keyboard shortcuts](#keyboard-shortcuts)
- [Requirements](#requirements)
- [Install](#install)
- [Setting up AI (LM Studio)](#setting-up-ai-lm-studio)
- [Build from source](#build-from-source)
- [Releasing](#releasing)
- [Architecture](#architecture)
- [Disclaimer](#disclaimer)

---

## Highlights

- 📝 **Live-preview Markdown editor** with Source / Live Preview / Reading modes
- 🔗 **Wikilinks, backlinks, unlinked mentions** and an interactive **graph view**
- 📊 **Dataview-style queries** (`TABLE`, `LIST`, `TASK`, `CALENDAR`, inline DQL)
- 🗓️ **Daily notes** + a month **calendar** with note-density dots
- 🤖 **Local AI** — chat, RAG over your vault, semantic search, page synthesis, and more, all through LM Studio (nothing leaves your machine)
- 📥 **Intelligent document ingestion** — drop a PDF / DOCX / TXT and get a clean Markdown note
- 🧩 **One file per pane** with split view and "open in right panel"
- 🔒 **Local-first** — plain Markdown files, a local SQLite index, your data stays yours
- 🔄 **Built-in auto-updater** driven by GitHub Releases

---

## Features

### Editor & Markdown

A CodeMirror 6–based editor with three per-note view modes (toggle with `⌘E`):

- **Source** — raw Markdown.
- **Live Preview** — formatting renders inline as you type (Obsidian-style); the syntax reveals itself only on the line you're editing.
- **Reading** — a clean, fully rendered document.

Rich rendering includes:

- **Headings, bold/italic/strikethrough, inline code, blockquotes**
- **Tables** — rendered, with an inline WYSIWYG table editor
- **Task lists** — `- [ ]` / `- [x]` with clickable checkboxes that write back to the file
- **Callouts** — `> [!note]`, `> [!warning]`, `> [!tip]`, `> [!insight]`, etc., color-coded
- **Math** — inline `$…$` and display `$$…$$` via KaTeX
- **Diagrams** — Mermaid code blocks render to diagrams
- **Highlights** — `==highlighted text==`
- **Footnotes**, **horizontal rules**, and **images/attachments** (including pasted images)
- **Embeds / transclusion** — `![[Note]]` and `![[Note#Heading]]` render the referenced content inline
- A **hideable formatting toolbar** (`⌘⇧B`) with one-click bold/italic, headings, lists, callouts, wikilinks, tags, and AI-context blocks

### Linking & knowledge graph

- **`[[Wikilinks]]`** with autocomplete, alias support (`[[Note|label]]`), heading/block targets (`[[Note#Heading]]`, `[[Note#^block]]`), and click-to-follow
- **Backlinks** panel — every note that links to the current one, with snippets
- **Unlinked mentions** — places your note's name appears without a link yet
- **Tags** — `#tag` indexing with a tag browser
- **Hover previews** — peek at a linked note without leaving the page
- **Graph view** (`⌘G`) — an interactive force-directed graph of your notes and their links

### Dataview-style queries

Write queries in fenced ` ```dataview ` blocks, evaluated live against your vault's metadata:

- **`TABLE`**, **`LIST`**, **`TASK`**, and **`CALENDAR`** query types
- **Inline DQL** for embedding computed values in text
- Filters on frontmatter fields, tags, folders, and file metadata (`file.name`, `file.mtime`, …)

### Daily notes & calendar

- **Daily notes** (`⌘D`) with a configurable folder, date format, and template
- A **calendar** tab (`⌘⇧C`) showing a month grid with **note-density dots**, today highlighting, and click-to-open any day's note; configurable week start (Sun/Mon)

### Panes & navigation

- **One file per pane** (Obsidian-style) — opening a note replaces the pane's content
- **Split view** and **"Open in right panel"** from the file-tree right-click menu (reuses the right pane to keep a tidy two-panel layout)
- **Command palette** (`⌘P`) — run any command
- **Quick switcher** (`⌘O`) — jump to any note by name
- **Full-text search** (`⌘⇧F`) across the vault
- **File tree** with create / rename / move (drag-and-drop) / delete and "Reveal in Finder"
- Fully **remappable hotkeys** (Settings → Hotkeys)

### Templates & bookmarks

- **Templates** — insert reusable note skeletons; supports a daily-note template
- **Bookmarks** — star notes for quick access from the sidebar

### AI features (local, via LM Studio)

All AI runs against a local [LM Studio](https://lmstudio.ai) server (OpenAI-compatible, default `http://localhost:1234/v1`). **Nothing is sent to any external service.**

- **AI Chat** (`⌘J`) — converse with your local model; assistant replies render as full Markdown (math, tables, code, wikilinks)
- **RAG chat** — chat *grounded in your vault*: Onyx retrieves the most relevant note chunks via semantic search and cites them inline as `[[Note]]`
- **Semantic search & vector index** — an on-device embeddings index (SQLite + `sqlite-vec`) you can build and search by meaning; incremental re-indexing happens automatically after edits (and stays a no-op until you've built an index, so it never bogs things down)
- **Synthesis** — generate a synthesized note from a scope (e.g. a tag or query) across your vault
- **Subject pages** — generate a structured page about a subject, grounded in your notes
- **Regenerate from vault** — re-run a previously AI-generated page to pull in new information
- **HCM (Hierarchical Context Metadata)** — embed per-section `<!--ai … -->` instructions and let Onyx **compose** each section while preserving everything else
- **StreamWeaver** (`⌘⇧W`) — analyze a free-form note and propose "weaves": new `[[links]]`, tasks, tags, block distribution to other notes, and new entity pages — which you accept individually
- **Suggested tags & links** — AI proposals for the current note

### Document ingestion

Bring outside documents into your vault as clean Markdown:

- **Drag-and-drop** a file onto the window, click the **📥** button in the file tree, or run **Import document…** from the command palette
- Supports **PDF, DOCX, and TXT**
- PDFs are processed **page by page** for high fidelity: each page is rendered to an image and combined with its extracted text, then reconstructed into Markdown — preserving headings, tables, lists, and math
- During conversion the model also adds **`> [!insight]` callouts** for key takeaways and **`[[wikilinks]]`** to matching notes already in your vault
- Live **per-page progress**, and graceful fallback to a chunked text-only conversion when needed

> 💡 For the highest-fidelity PDF import, install [poppler](https://poppler.freedesktop.org) (`brew install poppler`). Without it, Onyx falls back to text extraction.

### Local-first storage

- Your vault is **a folder of plain `.md` files** you choose and control
- Metadata lives in a `.onyx/` subfolder: a SQLite index (`onyx.db`), workspace layout, settings, and bookmarks
- A file-system watcher keeps the index in sync when files change on disk
- Switch vaults anytime from **Settings → Files & links → Vault**

### Auto-updates

- A built-in updater checks **GitHub Releases** on launch and from **Settings → Updates**
- Updates are integrity-verified with a minisign signature and applied in place
- Releases are **Developer ID–signed and notarized**, so downloaded builds open cleanly on any Mac

---

## Keyboard shortcuts

All shortcuts are remappable in **Settings → Hotkeys**. Defaults:

| Action | Shortcut |
| --- | --- |
| Command palette | `⌘P` |
| Quick switcher (open note) | `⌘O` |
| Search vault | `⌘⇧F` |
| New note | `⌘N` |
| Today's daily note | `⌘D` |
| Toggle edit / reading view | `⌘E` |
| Find / replace in note | `⌘F` |
| Graph view | `⌘G` |
| Open calendar | `⌘⇧C` |
| Toggle sidebar | `⌘\` |
| AI chat | `⌘J` |
| StreamWeaver | `⌘⇧W` |
| Toggle formatting toolbar | `⌘⇧B` |
| Bold / Italic | `⌘B` / `⌘I` |
| Insert wikilink | `⌘⇧K` |
| Settings | `⌘,` |

---

## Requirements

- **macOS on Apple Silicon** (arm64). Releases target `aarch64-apple-darwin`.
- **[LM Studio](https://lmstudio.ai)** (optional) — required only for the AI features. Load a chat model (a **vision-capable** model unlocks the best PDF import) and an embedding model for semantic search, then start its local server.
- **[poppler](https://poppler.freedesktop.org)** (optional) — `brew install poppler` for highest-fidelity PDF ingestion.

---

## Install

1. Download `Onyx_<version>_aarch64.dmg` from the **[latest release](https://github.com/cpkess/onyx/releases/latest)**.
2. Open the DMG and drag **Onyx** to Applications.
3. Launch it and pick a folder to use as your vault.

Builds are signed with a Developer ID certificate and notarized by Apple, so they open without the "damaged / move to trash" warning.

---

## Setting up AI (LM Studio)

1. Install [LM Studio](https://lmstudio.ai) and download a chat model (optionally a vision model) plus an embedding model.
2. Start LM Studio's **local server** (defaults to `http://localhost:1234/v1`).
3. In Onyx, open **Settings → AI (LM Studio)**, click **Test** to confirm the connection, pick your **chat** and **embedding** models, and **Save**.
4. (Optional) Click **Index vault** to build the semantic search / RAG index.

---

## Build from source

```bash
# Prerequisites: Node 20+, Rust (stable), and the Tauri prerequisites for macOS.
npm install

# Run in development (hot-reloading webview + Rust backend)
npm run tauri dev

# Build a release .app + .dmg and install it to /Applications (ad-hoc signed, local use)
npm run release
```

---

## Releasing

Releases are tag-driven and built, signed, notarized, and published by GitHub Actions (`.github/workflows/release.yml`):

```bash
# Bumps version across package.json / tauri.conf.json / Cargo.toml, commits, and tags
bash scripts/bump-version.sh 0.2.0
git push origin main
git push origin v0.2.0   # the tag triggers the signed + notarized release build
```

The workflow signs with an Apple **Developer ID Application** certificate and notarizes via an **App Store Connect API key**, then uploads the `.dmg`, the updater artifacts (`.app.tar.gz` + `.sig`), and `latest.json`. Required repository secrets: `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_API_ISSUER`, `APPLE_API_KEY`, `APPLE_API_KEY_BASE64`, and the updater's `TAURI_SIGNING_PRIVATE_KEY`.

A standalone `scripts/release-signed.sh` is also available for producing a signed + notarized build locally.

---

## Architecture

- **Frontend:** React 18 + TypeScript + Vite, Zustand state, Tailwind CSS, CodeMirror 6 editor
- **Backend:** Rust via Tauri 2 (uses the system WKWebView — no bundled Chromium)
- **Index/search:** SQLite (bundled) with the `sqlite-vec` extension for vector search
- **AI:** LM Studio's OpenAI-compatible API (`/models`, `/embeddings`, streaming `/chat/completions`)
- **Document import:** `pdf-extract` + poppler (`pdftoppm`/`pdftotext`) for PDFs; ZIP + XML parsing for DOCX

```
src/                 React app (components, editor, state, dataview, lib)
src/editor/render/   CodeMirror live-preview rendering (markdown, callouts, math, tables, embeds)
src-tauri/src/       Rust backend (commands, indexing, vault, vector search, AI, import)
.github/workflows/   Tag-driven signed release pipeline
scripts/             Version bump + local build/release helpers
sample-vault/        Example notes demonstrating features
```

---

## Disclaimer

Onyx is an independent personal project, inspired by Obsidian but not affiliated with or endorsed by Obsidian or its makers. "Obsidian" is a trademark of its respective owner.
