// @vitest-environment jsdom
import { renderPluginComponent } from '@mindroom/client-sdk/testing';
import { describe, expect, it } from 'vitest';
import plugin from '../index';
import { PullRequestReactions } from './Reactions';

const render = (ui: React.ReactElement) =>
  renderPluginComponent(ui, { id: 'pull-requests', plugin });

describe('PullRequestReactions', () => {
  it('shows an emoji and a count for each, in the order given', async () => {
    const view = await render(
      <PullRequestReactions
        reactions={[
          { content: 'heart', count: 3 },
          { content: '+1', count: 12 },
          { content: 'rocket', count: 1 },
        ]}
      />
    );
    const pills = [...view.container.querySelectorAll('.mrpr-reaction')];
    expect(pills.map((pill) => pill.textContent)).toEqual(['❤️3', '👍12', '🚀1']);
    expect(pills.map((pill) => pill.getAttribute('aria-label'))).toEqual([
      'heart, 3',
      'thumbs up, 12',
      'rocket, 1',
    ]);
  });

  it('has an emoji for every content', async () => {
    const contents = [
      '+1',
      '-1',
      'laugh',
      'hooray',
      'confused',
      'heart',
      'rocket',
      'eyes',
    ] as const;
    const view = await render(
      <PullRequestReactions reactions={contents.map((content) => ({ content, count: 1 }))} />
    );
    expect(
      [...view.container.querySelectorAll('.mrpr-reaction')].map((p) => p.textContent)
    ).toEqual(['👍1', '👎1', '😄1', '🎉1', '😕1', '❤️1', '🚀1', '👀1']);
  });

  it('renders nothing for none', async () => {
    const view = await render(<PullRequestReactions reactions={[]} />);
    expect(view.container.textContent).toBe('');
    expect(view.container.querySelector('.mrpr-reactions')).toBeNull();
  });
});
