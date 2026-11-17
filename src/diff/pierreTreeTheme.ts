// Ported from T3 Code (https://github.com/pingdotgg/t3code, apps/web/src/pierre-tree-theme.ts at 8ab427c6), MIT, Copyright (c) 2026 T3 Tools Inc. See NOTICE.
// The file tree in the app's colors and font: Pierre draws it in a shadow root, which takes these
// styles and inherits the --pr-* variables of pluginRootStyle().
import type { CSSProperties } from 'react';

export const PIERRE_TREE_UNSAFE_CSS = `
  :host {
    --trees-bg-override: transparent;
    --trees-selected-bg-override: color-mix(in srgb, currentColor 12%, transparent);
    --trees-hover-bg-override: color-mix(in srgb, currentColor 7%, transparent);
    --trees-border-color-override: color-mix(in srgb, currentColor 14%, transparent);
    --trees-font-family-override: var(--pr-font-sans);
    --trees-font-size-override: 0.75rem;
    /* Paths read left to right in every app language; Pierre's truncated names break otherwise. */
    direction: ltr;
  }
  [data-truncate-content='visible'] { overflow: hidden; text-overflow: ellipsis; }
  [data-truncate-marker] { display: none; }
  button[data-type='item'], button[data-type='item']::before { border-radius: 6px; }
  /* A folder's changed lines keep their width at the row's end; its name shrinks to its ellipsis. */
  [data-item-section='decoration'] { flex: none; margin-inline-start: auto; }
  /* Equal digit widths, right-aligned. */
  [data-item-section='decoration'] > span { gap: 0.35em; font-variant-numeric: tabular-nums; }
  /* A flattened chain of folders shows as many of its last folders as fit, each whole, and cuts
     only its last folder when that alone does not fit. Pierre's " / " text is hidden, and each
     folder but the last draws its own slash with Pierre's 2px gaps, so a folder and its slash
     go together. Placed from the last folder back (the order, in a reversed row), the folders
     that do not fit wrap onto a second line, which the row's one line hides. */
  [data-item-flattened-subitems] {
    font-size: 0; gap: 0; flex-flow: row-reverse wrap; justify-content: flex-end;
    height: 1lh; overflow: hidden; vertical-align: top;
  }
  [data-item-flattened-subitem] {
    display: flex; flex: none; align-items: center; height: 1lh; font-size: var(--trees-font-size);
    order: -1;
  }
  [data-item-flattened-subitem]:not(:last-child)::after { content: '/'; flex: none; margin-inline: 2px; }
  [data-item-flattened-subitem]:last-child { order: -12; flex-shrink: 1; min-width: 0; overflow: hidden; }
  [data-item-flattened-subitem]:nth-last-child(2) { order: -11; }
  [data-item-flattened-subitem]:nth-last-child(3) { order: -10; }
  [data-item-flattened-subitem]:nth-last-child(4) { order: -9; }
  [data-item-flattened-subitem]:nth-last-child(5) { order: -8; }
  [data-item-flattened-subitem]:nth-last-child(6) { order: -7; }
  [data-item-flattened-subitem]:nth-last-child(7) { order: -6; }
  [data-item-flattened-subitem]:nth-last-child(8) { order: -5; }
  [data-item-flattened-subitem]:nth-last-child(9) { order: -4; }
  [data-item-flattened-subitem]:nth-last-child(10) { order: -3; }
  [data-item-flattened-subitem]:nth-last-child(11) { order: -2; }
  [data-item-flattened-subitem]:nth-last-child(12) { order: -1; }
  /* Pierre's hover underline, on the folder's name and not its slash. */
  [data-item-flattened-subitem]:hover, [data-item-flattened-subitem-drag-target='true'] { text-decoration: none; }
  [data-item-flattened-subitem]:hover > *, [data-item-flattened-subitem-drag-target='true'] > * { text-decoration: underline; }
`;

export function pierreTreeStyle(colorScheme: 'light' | 'dark'): CSSProperties {
  return {
    colorScheme,
    ['--trees-fg-override' as string]: 'var(--pr-fg)',
  };
}
