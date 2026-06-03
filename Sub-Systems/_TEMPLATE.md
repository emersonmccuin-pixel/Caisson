# <Subsystem Name>

> **Role:** Supervisor | Engine | Brain | Store | UI | cross-cutting
> **Status:** as-built snapshot — <date>
> **Code anchors:** `path/one` · `path/two` · … (compact, one block)

---

## What it is (plain English)

2–5 sentences a non-technical reader fully understands. **Open with an analogy if one fits**
("a workflow is an assembly line for a card"). No jargon in the first sentence.

## What it's supposed to do (intent)

The one job this subsystem owns and *why it exists*. State its laws/invariants in plain words.

## The parts (every component, plain English)

**The heart of the doc.** Break the subsystem into its components, organized by the *user's mental
model* (how Emerson would list the pieces) — NOT by code file. Numbered sub-sections, one per part.

Rules for every part:
- **Plain English leads.** What it is and does in normal words FIRST; file paths / symbols in
  parentheses AFTER, or dropped.
- **Define each technical term** in a few words the first time it appears.
- **Tables** for anything field-like (settings, statuses, columns) — column per: name, plain
  meaning, example.
- Flag gaps inline: 📌 rebuild requirement · ⚠️ open decision · ☠ sentenced (FD-x).

## How it connects

Depends on / used by / what crosses the boundary — each in plain words, one line per item.

## Target shape (per north star + Foundation Decisions)

What this becomes in the rebuild. Cite the ledger verdict and any `_Foundation-Decisions.md`
entries (FD-x). What's already done vs. remaining. Keep ☠ tombstones for sentenced pieces.

## Known issues / scar tissue

Plain words first ("the diary is write-only"), technical specifics after. Quote the lesson if
one was burned in.

## Decisions & open questions

Two buckets:
- **For Emerson (product calls):** framed in product terms — what he'll experience, not
  architecture labels. These feed `_Foundation-Decisions.md`.
- **Technical:** open engineering questions.

---

### Format rules (apply to the whole doc)

1. Every section leads with plain English; jargon and paths come after or get dropped.
2. Ground every claim in real code (`path:line`); mark anything unverified with `(unverified)`.
3. Keep all ☠ FD tombstones and FD-x references intact — they're the rebuild's law.
4. Gold-standard examples: `2-brain/agents-pods.md` and `2-brain/workflow-engine.md`.
