import { color } from 'folds';
import { describe, expect, it } from 'vitest';
import { pluginRootStyle } from './theme';

describe('pluginRootStyle', () => {
  // The app's theme tokens are variables whose values change with the theme; a state's color is a
  // color of its own, GitHub's, the same in the light and dark themes.
  it("gives a pull request's states GitHub's colors, whatever the theme", () => {
    expect(pluginRootStyle()).toMatchObject({
      '--pr-open': '#2da44e',
      '--pr-closed': '#da3633',
      '--pr-merged': '#8957e5',
      '--pr-draft': '#848d97',
    });
  });

  it("gives a highlighted row the theme's primary container line and text", () => {
    const style = pluginRootStyle() as Record<string, unknown>;
    for (const name of ['--pr-primary-container-line', '--pr-on-primary-container']) {
      expect(style[name]).toMatch(/^var\(--/);
    }
  });

  it('uses Surface.Container for the floating panel card and SurfaceVariant tokens for subtle sub-cards', () => {
    expect(pluginRootStyle()).toMatchObject({
      '--pr-panel': color.Surface.Container,
      '--pr-surface': color.Surface.Container,
      '--pr-surface-subtle': color.SurfaceVariant.Container,
      '--pr-surface-subtle-line': color.SurfaceVariant.ContainerLine,
      '--pr-surface-subtle-hover': color.SurfaceVariant.ContainerHover,
    });
  });
});
