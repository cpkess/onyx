# Concept: [[StreamWeaver]]
*“Write like water. Organize like crystal.”*

**StreamWeaver** is an Onyx plugin that allows you to write your daily notes in a continuous, unstructured stream of consciousness. In the background (or on-demand), it uses a lightweight local LLM to parse your text, extract actionable items, link relevant entities, and distribute blocks of information to their correct destinations in your vault—all while preserving your original daily note.

---

## 1. Core Pillars of the Plugin

### A. Contextual Auto-Linking (Entity Extraction)
As you write, you mention people, projects, and topics. StreamWeaver analyzes your vault's existing note titles and automatically suggests or inserts markdown links.
* **How it works:** If you write *"talked to Jessica about the website redesign,"* the plugin scans your vault, finds `Jessica Chen.md` and `Website Redesign Project.md`, and transforms your text to: `talked to [[Jessica Chen]] about the [[Website Redesign Project]]`.
* **Smart Creation:** If a note doesn't exist (e.g., a new contact), it can flag it in a sidebar: *"Would you like to create a new note for 'Jessica Chen' using your Person template?"*

### B. Intelligent Task & Follow-up Extraction
Instead of requiring you to format tasks manually with `- [ ]` and specific tags, StreamWeaver extracts them from natural language.
* **How it works:** You write: *"Need to email Bob the updated PDF by Friday morning."*
* **The Transformation:** The plugin formats this inline as a standard Onyx task: `- [ ] Email Bob the updated PDF 📅 2026-06-26 ^task-id`. 
* **Global Sync:** It can copy/transclude this task to a centralized `Tasks.md` file or a specific project file, maintaining a block reference (`^task-id`) back to the exact daily note where the idea was born.
- [ ] Email Bob the updated PDF by Friday morning. 📅 2026-06-26 ^sw-mqpyef8w959

### C. Information Distribution (Block-Ref Transclusion)
This is the most powerful feature. StreamWeaver doesn't just link notes; it *distributes* the context.
* **How it works:** You write a paragraph of notes during a meeting about "Project Apollo." 
* **The Transformation:** StreamWeaver identifies this block as relevant to `Project Apollo.md`. It leaves the original text in your daily note, but appends a block reference link to `Project Apollo.md` under a designated "Log" or "Meeting Notes" section. 
* When you open `Project Apollo.md`, you see a chronological feed of every mention of this project across all your daily notes, pulled in via block transclusion (`![[Daily Note#^block-id]]`). ^sw-mqpyef97186

### D. Semantic Tagging
Instead of you having to remember to type `#idea`, `#decision`, or `#bookmark`, the plugin categorizes blocks based on semantic meaning.
* *"We decided to push the launch to October."* → Automatically tagged `#decision`.
* *"What if we used a three-column layout instead?"* → Automatically tagged `#idea`. #decision

---

## 2. The User Experience (UX): How It Feels

To keep the stream-of-consciousness flow intact, the plugin should never interrupt your writing. It operates in three optional modes:

1. **The "Weave" Sidebar (Interactive Mode):** 
   As you write, a sidebar quietly populates with "Proposed Weaves." It might show:
   * *Link:* "Sarah" → `[[Sarah Smith]]`? (Accept/Ignore)
   * *Task:* "Send report by tomorrow" → Add to `Tasks.md`? (Accept/Ignore)
   * *Move:* Move paragraph 3 to `[[Project Apollo]]`? (Accept/Ignore)
   * You can accept them individually or hit `Cmd/Ctrl + Enter` to "Weave All."
2. **Auto-Pilot (Background Mode):**
   The plugin processes your note when you switch away from it or when Onyx is idle for more than 5 minutes. It auto-formats and distributes the notes according to your pre-set rules.
3. **End-of-Day Review (Ritual Mode):**
   At the end of the day, you trigger the plugin. It highlights your daily note in a split-screen view, showing you exactly how it proposes to clean up, link, and archive your daily thoughts before you close your laptop.

---

## 3. Practical Scenario: Before and After

### **Before (What you write in your daily note):**
- [ ] Update the spreadsheet and send it to Dave 📅 2026-06-24 ^sw-mqpyef8z17
> 9:30 AM. Drank too much coffee. Met with Dave and Sarah about the [[Q3 Marketing Budget|Q3 marketing budget]]. Dave thinks we should cut ad spend by 10% but Sarah wants to reallocate it to influencer marketing. We decided to split the difference (5% cut, 5% to influencers). I need to update the spreadsheet and send it to Dave by Wednesday. Also, random thought: we should look into sponsoring that tech podcast we listened to yesterday.

### **After (How StreamWeaver processes it):**
1. **Your Daily Note is polished and linked:**
   > 9:30 AM. Drank too much coffee. Met with [[Dave Jones]] and [[Sarah Miller]] about the [[Q3 Marketing Budget]]. Dave thinks we should cut ad spend by 10% but Sarah wants to reallocate it to influencer marketing. We decided to split the difference (5% cut, 5% to influencers) #decision. 
   > - [ ] Update the spreadsheet and send it to [[Dave Jones]] 📅 2026-06-24 ^task-930am
   > 
   > *Random thought:* we should look into sponsoring that tech podcast we listened to yesterday. #idea ^idea-930am #idea #decision

2. **Your Vault is updated behind the scenes:**
   * **In `Dave Jones.md` and `Sarah Miller.md`:** A block link is appended under their "Interaction History" pointing back to this daily note block.
   * **In `Q3 Marketing Budget.md`:** The decision block (`#decision`) is transcluded into the "Decisions" section.
   * **In your central `Tasks.md`:** The task to update the spreadsheet is appended.
   * **In `Marketing Ideas.md`:** The podcast idea block is appended.

---

## 4. Technical Feasibility & Onyx Architecture

* **Engine:** This could run locally using **LM Studio** to ensure complete data privacy—a massive priority for the Onyx community. Alternatively, it could support OpenAI/Anthropic APIs for users who want faster, cloud-based processing.
* **Markdown AST Parsing:** The plugin would use Onyx's metadata cache and a Markdown parser (like unified/remark) to analyze the structure of your daily note, ensuring it only modifies the text blocks you want it to, without messing up your custom formatting or frontmatter.
* **Configuration File (`streamweaver.json`):** Users can define rules using simple JSON or a UI. For example:
  * *"If a block contains a decision, append it to `Decisions Log.md`."*
  * *"If a block mentions a person in the folder `Contacts/`, link them and append the block to their note."*
