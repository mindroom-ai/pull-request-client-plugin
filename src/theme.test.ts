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
});
