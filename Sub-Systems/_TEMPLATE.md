# <Subsystem Name>

> **Role:** Supervisor | Engine | Brain | Store | UI | cross-cutting
> **Status:** as-built snapshot — 2026-06-03
> **Code anchors:** `path/one`, `path/two`, …

## What it is (plain English)

2–4 sentences a non-technical reader understands. What is this thing, in normal words?

## What it's supposed to do (intent)

The one job this subsystem owns and *why it exists*. The reason it's a separate thing.

## How it works today (as-built)

- The real flow, step by step, grounded in the code.
- Key components and what each does (name the file).
- Where state lives.

## Integrations (how it connects)

- **Depends on:** subsystems/services it calls or reads.
- **Used by:** who calls into it.
- **Contracts / events crossed:** the typed contracts, DB tables, or live events at its edges.

## Target shape (per north star)

How this should look in the unified five-role design (`refactor plan/unified-process-supervision-2026-06-02.md`). Keep / merge / delete / rebuild verdict if the ledger states one. What changes from today.

## Known issues / scar tissue

Dual paths, races, fragile timing, hard-won lessons. Quote the specific bug if known.

## Open questions

Things to resolve before/while rebuilding this in the new architecture.
