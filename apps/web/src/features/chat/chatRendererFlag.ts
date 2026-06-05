// Chat-view user toggles (localStorage-backed).
//
// ☠ S8c: the JSONL-canonical A/B flag (`caisson.chat.jsonlCanonical`,
// isJsonlCanonicalChat / setJsonlCanonicalChatOverride) is DELETED — the
// canonical renderer is THE render path; the legacy dual-source path is gone
// (banned-resurrection: don't re-add a renderer flag).

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
