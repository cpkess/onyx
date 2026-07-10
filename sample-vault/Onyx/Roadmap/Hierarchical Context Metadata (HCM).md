# Feature Brief: Hierarchical Context Metadata (HCM)

## Overview
**Hierarchical Context Metadata (HCM)** is a new markdown-compatible format designed to bridge the gap between static note-taking and intelligent AI generation. It introduces a hideable metadata layer attached to specific headers (`#`, `##`, `###`) that provides per-section instructions, constraints, and context for LLMs [[Roadmap]].

The goal is to move away from "single-prompt" generation toward a structured, section-by-section execution where the AI leverages established structural anchors to populate content accurately without disrupting existing formatting or custom structures.

## Problem Statement
Currently, when requesting an AI regeneration of a page, LLMs often struggle to maintain a specific user-defined structure or may inadvertently overwrite custom formatting [[Roadmap]]. Without section-specific context, the AI lacks the "instructional memory" required to know exactly what information belongs under which header in a complex document.

## Proposed Solution
Introduce a hidden metadata block—compatible with Markdown AST parsing (similar to the proposed **StreamWeaver** logic)—that lives directly beneath or within a header definition [[StreamWeaver]].

### Key Capabilities:
* **Per-Section Instructions:** Users or AI when generating a new page can define specific personas, tones, or data requirements for individual headers (e.g., "This section must always include a summary of decisions").
* **Structural Anchoring:** During an AI regeneration request, the system reads these metadata blocks to ensure the established document hierarchy remains intact [[Roadmap]].
* **Iterative Section-by-Section Generation:** The AI tool will traverse the document tree, treating each header and its associated HCM as a discrete task. It will use the metadata to populate only the relevant sections, preventing "hallucinations" or structural drift.
* **Contextual Inheritance:** Metadata defined at a high-level header (e.g., `# Project Alpha`) can be inherited by sub-headers (`## Tasks`), providing a cascading context for the LLM.

## Technical Implementation Notes
* **Parsing:** The feature should utilize a Markdown parser (such as `unified/remark`) to identify these metadata blocks without rendering them in the standard "Reading" view [[StreamWeaver]].
* **Visibility:** These sections should be "hideable," appearing only in an "Edit" or "AI Context" mode to maintain the clean, plain-text transparency of Onyx [[Welcome]].
* **Integration with Roadmap:** This feature directly supports the roadmap goal: *"Leverage # headers as sub-page regeneration for deeper ai generation. Forced structure."* [[Roadmap]].

## User Workflow Example
1.  **Create:** A user creates a `# Meeting Notes` header and adds an HCM block: `[Context: Extract action items from the text below]`.
2.  **Input:** The user pastes raw, unformatted transcript text into the note.
3.  **Execute:** The user triggers "AI Regenerate."
4.  **Result:** The AI reads the HCM, identifies the instruction, and populates the meeting notes section with a structured list of action items while leaving the rest of the document's structure untouched.