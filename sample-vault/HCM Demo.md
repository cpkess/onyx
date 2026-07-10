> **How to use this demo (this intro has no heading, so Compose never touches it):**
> 1. In **Live** mode you'll see a small `✨ AI context` badge under each heading — click it (or move the cursor onto it) to reveal the raw `<!--ai … -->` instruction. In **Reading** mode the blocks disappear entirely.
> 2. With LM Studio running, open the **AI** sidebar → **Tools** tab and click **Compose sections** (or run the command palette → *AI: Compose sections from AI context (HCM)*).
> 3. Onyx walks the headings and rewrites **only** the sections that have an `<!--ai-->` block, transforming the raw material below each one. The `## Reference` section has no block, so it's left byte-for-byte untouched.
> 4. To add your own: put the cursor in a section and run *Insert AI context block (HCM)*.

# Weekly Review — Project Apollo
<!--ai
Write a terse 1–2 sentence status overview for the week. Neutral, factual tone.
This tone is inherited by the sub-sections below. Cite related notes as [[wikilinks]].
-->
The design team is finalizing high-fidelity wireframes for the [[Project Apollo|Apollo dashboard]] with delivery expected by tomorrow afternoon. Documentation regarding the user authentication endpoint remains outstanding following a check with Elena [[2026-06-22]].

## Meeting Notes
<!--ai
Extract action items as a checklist (`- [ ] owner — task`). Then add a `### Decisions` subsection summarizing what was decided. Ignore chit-chat.
-->
- [ ] Sarah — chase vendor regarding firmware signature and confirm date
- [ ] Dave — send updated Q3 budget spreadsheet by Wednesday

### Decisions
* If vendor firmware is not signed by Friday, the Pro Power Onboard rollout will be removed from the Q3 launch.
* The Apollo demo has been rescheduled to the 28th to provide engineering with additional buffer time.

## Risks
<!--ai
Turn the notes below into a bullet list. Each bullet: `**<risk>** — <impact>; <mitigation>` and a severity tag (High/Med/Low).
-->
- **Firmware signing delay** — Blocks onboard launch; implement hard cut on Friday (High)
- **Budget spreadsheet errors** — Risk of communicating incorrect figures to marketing; automate or audit manual entries (Medium)
- **Demo schedule compression** — Reduced buffer for QA blockers following move to the 28th; monitor QA progress closely (Low)

## Reference
This section has **no** AI-context block, so Compose leaves it exactly as written.

- Related: [[Project Apollo]], [[Pro Power Onboard]], [[Q3 Marketing Budget]]
- Owner: Dave · Reviewer: Sarah
