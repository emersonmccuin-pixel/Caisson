// Single source of truth for font options — used by the settings UI dropdowns
// and by the CSS-var apply logic in App.tsx / AppSettingsModal.tsx.

import { FONT_KEYS, MONO_FONT_KEYS, type FontKey, type FontGroup, type FontSettings } from './types';

export interface FontEntry {
  label: string;
  cssStack: string;
}

/** Full registry: key → display label + CSS font-family stack. */
export const FONT_REGISTRY: Record<FontKey, FontEntry> = {
  inter: {
    label: 'Inter',
    cssStack: "'Inter', 'Helvetica Neue', Arial, sans-serif",
  },
  'ibm-plex-sans': {
    label: 'IBM Plex Sans',
    cssStack: "'IBM Plex Sans', 'Helvetica Neue', Arial, sans-serif",
  },
  'atkinson-hyperlegible': {
    label: 'Atkinson Hyperlegible',
    cssStack: "'Atkinson Hyperlegible', 'Helvetica Neue', Arial, sans-serif",
  },
  'source-serif-4': {
    label: 'Source Serif 4',
    cssStack: "'Source Serif 4', Georgia, 'Times New Roman', serif",
  },
  system: {
    label: 'System (sans)',
    cssStack: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', sans-serif",
  },
  'jetbrains-mono': {
    label: 'JetBrains Mono',
    cssStack: "'JetBrains Mono', 'Cascadia Mono', 'Fira Code', Consolas, ui-monospace, monospace",
  },
  'fira-code': {
    label: 'Fira Code',
    cssStack: "'Fira Code', 'Cascadia Mono', 'JetBrains Mono', Consolas, ui-monospace, monospace",
  },
  'ibm-plex-mono': {
    label: 'IBM Plex Mono',
    cssStack: "'IBM Plex Mono', 'Cascadia Mono', Consolas, ui-monospace, monospace",
  },
  'system-mono': {
    label: 'System Mono',
    cssStack: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace",
  },
};

/** Return the font keys eligible for a given group.
 *  `code` → mono only; all other groups → all fonts. */
export function fontsForGroup(group: FontGroup): FontKey[] {
  if (group === 'code') return [...MONO_FONT_KEYS];
  return [...FONT_KEYS];
}

/** CSS font-family stack for a given key. Falls back to JetBrains Mono on
 *  unknown key (should never happen after normalisation). */
export function getCssStack(key: FontKey): string {
  return FONT_REGISTRY[key]?.cssStack ?? FONT_REGISTRY['jetbrains-mono'].cssStack;
}

/** Write all four font CSS custom properties onto `documentElement` so every
 *  surface picks them up immediately. Call this on load and on settings change. */
export function applyFontCssVars(fonts: FontSettings): void {
  document.documentElement.style.setProperty('--font-chat', getCssStack(fonts.chat));
  document.documentElement.style.setProperty('--font-content', getCssStack(fonts.workItems));
  document.documentElement.style.setProperty('--font-ui', getCssStack(fonts.ui));
  document.documentElement.style.setProperty('--font-code', getCssStack(fonts.code));
}
