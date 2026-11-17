import { describe, expect, it } from 'vitest';

import { pierreTreeStyle } from './pierreTreeTheme';

describe('pierreTreeStyle', () => {
  it("draws the tree's text, icons, chevrons, guides and ignored rows in the panel's colors", () => {
    for (const scheme of ['light', 'dark'] as const) {
      expect(pierreTreeStyle(scheme)).toEqual({
        colorScheme: scheme,
        '--trees-fg-override': 'var(--pr-fg)',
        '--trees-fg-muted-override': 'var(--pr-muted)',
        '--trees-status-ignored-override': 'var(--pr-muted)',
      });
    }
  });
});
