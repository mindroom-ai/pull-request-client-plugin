// @vitest-environment jsdom
import { act } from './testing/act';
import { renderPluginComponent } from '@mindroom/client-sdk/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import plugin from './index';
import { useRootFontSize } from './rootFontSize';

let size = 0;
function Probe() {
  size = useRootFontSize();
  return null;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => {
  document.documentElement.style.fontSize = '';
});

describe('useRootFontSize', () => {
  it("follows the root's font size, which the page zoom sets", async () => {
    document.documentElement.style.fontSize = '16px';
    await renderPluginComponent(<Probe />, { id: 'pull-requests', plugin });
    expect(size).toBe(16);
    // The observer reports the change in a microtask after it.
    await act(async () => {
      document.documentElement.style.fontSize = '24px';
      await Promise.resolve();
    });
    expect(size).toBe(24);
  });
});
