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
`;

export function pierreTreeStyle(colorScheme: 'light' | 'dark'): CSSProperties {
  return {
    colorScheme,
    ['--trees-fg-override' as string]: 'var(--pr-fg)',
  };
}
