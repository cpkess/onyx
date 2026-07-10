# Project Nimbus

This page is (mostly) **built by other notes**. You barely type here — you capture
in your daily journal, link back to this page, and the sections below
assemble themselves from every block across the vault that mentions this page.

Scroll to the bottom to see the raw **Linked References**, or read the organized
**primitives** below.

## ✅ Open work
The `todo` primitive gathers every task block that links to this page — from any
journal — into one live checklist. Open items come first. Tick one here and it
writes back to the **source** line in the journal it came from.

```onyx-primitive
type: todo
```

## 🧠 What we've captured
The `notes` primitive collects the non-task bullets and paragraphs that mention
this page — the running narrative of the project.

```onyx-primitive
type: notes
```

## 📌 Where it's discussed
The `mentions` primitive counts how many blocks in each note reference this page,
busiest first.

```onyx-primitive
type: mentions
```

## 🏁 Decisions
The `decisions` primitive surfaces approved **decision** atoms plus any journal
block that reads like a decision (`Decision: …`).

```onyx-primitive
type: decisions
```

## 🚧 Pain points
The `pain-points` primitive surfaces **pain_point** atoms plus blocks that read
like a problem (`Problem: …`, `Blocker: …`).

```onyx-primitive
type: pain-points
```

## 💡 Insights
The `insights` primitive surfaces **insight** atoms plus blocks that read like an
insight (`Insight: …`, `Idea: …`).

```onyx-primitive
type: insights
```
