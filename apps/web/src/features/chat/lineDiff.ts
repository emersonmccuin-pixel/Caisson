/** LCS-based line-level diff. No external dependencies. */

export type DiffLine =
  | { type: 'context'; text: string; oldLineNo: number; newLineNo: number }
  | { type: 'add'; text: string; newLineNo: number }
  | { type: 'remove'; text: string; oldLineNo: number };

export type CollapsedDiffRow = DiffLine | { type: 'collapse'; count: number };

export interface DiffStats {
  added: number;
  removed: number;
}

/**
 * Compute a unified line diff using LCS (Myers-style via DP table).
 * Falls back to remove-all/add-all when m×n > 100 000 to avoid quadratic blow-up.
 */
export function computeLineDiff(oldText: string, newText: string): DiffLine[] {
  const oldLines = oldText.length === 0 ? [] : oldText.split('\n');
  const newLines = newText.length === 0 ? [] : newText.split('\n');

  const m = oldLines.length;
  const n = newLines.length;

  if (m === 0 && n === 0) return [];

  // Safety cap — avoid O(mn) on huge pastes
  if (m * n > 100_000) {
    const result: DiffLine[] = [];
    for (let i = 0; i < m; i++) result.push({ type: 'remove', text: oldLines[i]!, oldLineNo: i + 1 });
    for (let j = 0; j < n; j++) result.push({ type: 'add', text: newLines[j]!, newLineNo: j + 1 });
    return result;
  }

  // Build LCS DP table
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i]![j] =
        oldLines[i - 1] === newLines[j - 1]
          ? dp[i - 1]![j - 1]! + 1
          : Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
    }
  }

  // Backtrack from (m, n) → push in reverse order, then flip
  const result: DiffLine[] = [];
  let i = m;
  let j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      result.push({ type: 'context', text: oldLines[i - 1]!, oldLineNo: i, newLineNo: j });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i]![j - 1]! >= dp[i - 1]![j]!)) {
      result.push({ type: 'add', text: newLines[j - 1]!, newLineNo: j });
      j--;
    } else {
      result.push({ type: 'remove', text: oldLines[i - 1]!, oldLineNo: i });
      i--;
    }
  }

  return result.reverse();
}

/** Count additions and removals in a diff. */
export function diffStats(lines: DiffLine[]): DiffStats {
  let added = 0;
  let removed = 0;
  for (const l of lines) {
    if (l.type === 'add') added++;
    else if (l.type === 'remove') removed++;
  }
  return { added, removed };
}

/**
 * Collapse long runs of unchanged context lines into a single placeholder row.
 * Lines within `contextSize` of any change are always kept.
 */
export function collapseDiff(lines: DiffLine[], contextSize = 3): CollapsedDiffRow[] {
  if (lines.length === 0) return [];

  // Mark which indices must be shown (within contextSize of a non-context line)
  const keep = new Uint8Array(lines.length);
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.type !== 'context') {
      const lo = Math.max(0, i - contextSize);
      const hi = Math.min(lines.length - 1, i + contextSize);
      for (let k = lo; k <= hi; k++) keep[k] = 1;
    }
  }

  const result: CollapsedDiffRow[] = [];
  let i = 0;
  while (i < lines.length) {
    if (keep[i]) {
      result.push(lines[i]!);
      i++;
    } else {
      let count = 0;
      while (i < lines.length && !keep[i]) {
        count++;
        i++;
      }
      result.push({ type: 'collapse', count });
    }
  }
  return result;
}
