// Feature flag for the JSONL-canonical chat renderer
// (docs/chat-canonical-source-redesign.md). Off by default. While both render
// paths coexist (Stages 2–5) this selects between them so the legacy path stays
// the trustworthy A/B baseline.
//
// Resolution order: localStorage override (live-toggleable in DevControls,
// survives reload) > VITE_CHAT_JSONL_CANONICAL build env > default (false).

const STORAGE_KEY = 'caisson.chat.jsonlCanonical';

// Default ON for A/B validation (effectively Stage 5, dev). The localStorage
// override still wins, so legacy is one keystroke away:
//   localStorage.setItem('caisson.chat.jsonlCanonical','0'); location.reload()
// Env var can force a value if set; otherwise the default below applies.
const DEFAULT_CANONICAL = true;

function envDefault(): boolean {
  const raw = (import.meta.env as Record<string, string | undefined>).VITE_CHAT_JSONL_CANONICAL;
  if (raw === '1' || raw === 'true') return true;
  if (raw === '0' || raw === 'false') return false;
  return DEFAULT_CANONICAL;
}

/** True when the JSONL-canonical chat renderer should be used. Read at render
 *  time; the localStorage override wins so it can be flipped without a rebuild. */
export function isJsonlCanonicalChat(): boolean {
  try {
    const override = localStorage.getItem(STORAGE_KEY);
    if (override === '1' || override === 'true') return true;
    if (override === '0' || override === 'false') return false;
  } catch {
    // localStorage unavailable (SSR / privacy mode) — fall back to env.
  }
  return envDefault();
}

/** Set or clear the override (null clears, reverting to the env default). */
export function setJsonlCanonicalChatOverride(value: boolean | null): void {
  try {
    if (value === null) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, value ? '1' : '0');
  } catch {
    // no-op when storage is unavailable
  }
}

const HIDE_SYSTEM_KEY = 'caisson.chat.hideSystemMessages';

/** FD-6 — user filter for mailbox-injected system messages (the `[pc:…]`
 *  marked user turns). SHOWN by default; this flag hides them. */
export function isHideSystemMessages(): boolean {
  try {
    return localStorage.getItem(HIDE_SYSTEM_KEY) === '1';
  } catch {
    return false;
  }
}

export function setHideSystemMessages(value: boolean): void {
  try {
    if (value) localStorage.setItem(HIDE_SYSTEM_KEY, '1');
    else localStorage.removeItem(HIDE_SYSTEM_KEY);
  } catch {
    // no-op when storage is unavailable
  }
}

const REVEAL_HIDDEN_KEY = 'caisson.chat.revealHidden';

/** Debug toggle: render rows the policy marks `hidden` (queue churn, titles,
 *  file-history, etc.) instead of filtering them. Off by default; canonical
 *  renderer only. */
export function isRevealHiddenChatRows(): boolean {
  try {
    return localStorage.getItem(REVEAL_HIDDEN_KEY) === '1';
  } catch {
    return false;
  }
}

export function setRevealHiddenChatRows(value: boolean): void {
  try {
    if (value) localStorage.setItem(REVEAL_HIDDEN_KEY, '1');
    else localStorage.removeItem(REVEAL_HIDDEN_KEY);
  } catch {
    // no-op when storage is unavailable
  }
}
