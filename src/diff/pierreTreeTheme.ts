// Ported from T3 Code (https://github.com/pingdotgg/t3code, apps/web/src/pierre-tree-theme.ts at 8ab427c6), MIT, Copyright (c) 2026 T3 Tools Inc. See NOTICE.
// The file tree in the app's colors and font: Pierre draws it in a shadow root, which takes these
// styles and inherits the --pr-* variables of pluginRootStyle().
import type { CSSProperties } from 'react';

// A flattened chain's folders by their place from its end, so that its last folders come first
// in the reversed row. Folders past the limit are left out, as they could only show out of order;
// the chain then starts with a slash, as it does when folders are hidden for want of room.
const FLATTENED_CHAIN_LIMIT = 32;
const FLATTENED_CHAIN_ORDER = Array.from({ length: FLATTENED_CHAIN_LIMIT }, (_, index) => {
  const place = index + 1;
  const order = place - FLATTENED_CHAIN_LIMIT - 1;
  return `[data-item-flattened-subitem]:nth-last-child(${place}) { order: ${order}; }`;
}).join('\n  ');

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
     folder but the first draws its own slash before it with Pierre's 2px gaps, so a folder and
     its slash go together and a chain with folders hidden starts with a slash. Placed from the
     last folder back (the order, in a reversed row), the folders that do not fit wrap onto a
     second line, which the row's one line hides. The slashes are decoration: the row's label
     names the path. */
  [data-item-flattened-subitems] {
    font-size: 0; gap: 0; flex-flow: row-reverse wrap; justify-content: flex-end;
    height: 1lh; overflow: hidden; vertical-align: top;
  }
  [data-item-flattened-subitem] {
    display: flex; flex: none; align-items: center; height: 1lh; font-size: var(--trees-font-size);
  }
  [data-item-flattened-subitem]:not(:first-child)::before {
    content: '/';
    content: '/' / '';
    flex: none;
    margin-inline: 2px;
  }
  [data-item-flattened-subitem]:last-child { flex-shrink: 1; min-width: 0; overflow: hidden; }
  ${FLATTENED_CHAIN_ORDER}
  [data-item-flattened-subitem]:nth-last-child(n + ${FLATTENED_CHAIN_LIMIT + 1}) { display: none; }
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
