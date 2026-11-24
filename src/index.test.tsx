import { describe, expect, it } from 'vitest';
import { parsePullRequestUrl } from './github';
import plugin from './index';

describe('plugin', () => {
  it("a pull request link opens the pull-request panel with the card's request", () => {
    const sidePanel = plugin.messageLinks?.[0]?.sidePanel;
    expect(sidePanel?.id).toBe('pull-request');
    const url = new URL('https://github.com/mindroom-ai/mindroom-chat/pull/490');
    const request = sidePanel?.request(url);
    // The value PullRequestCard passes to panel.open, so a second click follows the link.
    expect(request).toEqual(parsePullRequestUrl(url));
    expect(JSON.stringify(request)).toBe(JSON.stringify(parsePullRequestUrl(url)));
    expect(request).toEqual({ owner: 'mindroom-ai', repo: 'mindroom-chat', number: 490 });
  });

  it('hides the pull-request side panel from the room header and room menu', () => {
    expect(plugin.sidePanels?.[0]).toMatchObject({ id: 'pull-request', placement: 'none' });
  });
});
