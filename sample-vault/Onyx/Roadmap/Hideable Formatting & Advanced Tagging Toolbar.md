# Feature Brief: Hideable Formatting & Advanced Tagging Toolbar

## Objective
To introduce a UI enhancement that provides quick access to text formatting and advanced tagging (such as AI-specific tags) without compromising the core principle of plain-text transparency [[Welcome]].

## Feature Overview
This feature involves implementing a "hideable" toolbar that sits within the Onyx interface. It will provide a streamlined way to apply markdown formatting and insert advanced metadata tags while remaining unobtrusive during standard reading or writing tasks [[Onyx Roadmap], [Hierarchical Context Metadata (HCM)]].

## Key Requirements

### 1. Functionality
* **Formatting Tools:** The toolbar will include essential tools for markdown formatting, as outlined in the current development roadmap [[Roadmap]].
* **Advanced Tagging:** Support for inserting advanced tags, specifically including a new "AI tag" to facilitate deeper AI generation and structured content [[Onyx Roadmap], [User Prompt]].
* **Collapsibility:** To maintain a clean interface, the toolbar must be hideable or collapsable, mirroring the planned functionality for headers in the roadmap [[Roadmap]].

### 2. Technical Implementation & Visibility
* **Plain-Text Integrity:** The toolbar must function as a UI layer that does not alter the underlying structure of the plain markdown files [[Welcome]].
* **Contextual Visibility:** Following the design pattern established for Hierarchical Context Metadata (HCM), the advanced elements of the toolbar should be "hideable." These tools should ideally appear or become prominent during "Edit" or "AI Context" modes, while remaining hidden in a standard "Reading" view to maintain a clean workspace [[Hierarchical Context Metadata (HCM)].

## Alignment with Project Goals
* **Connectivity:** Enhances the ability to create a "connected web of notes" by making tagging more efficient [[Overview]].
* **Incremental Development:** This feature builds upon existing roadmap goals regarding toolbars and collapsible UI elements [[Roadmap]].
