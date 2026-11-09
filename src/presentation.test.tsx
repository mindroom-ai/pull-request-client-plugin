// @vitest-environment jsdom
import { renderPluginComponent } from '@mindroom/client-sdk/testing';
import { describe, expect, it } from 'vitest';
import plugin from './index';
import { PullRequestDiffStat, resolvePullRequestState } from './presentation';

const render = (ui: React.ReactElement) =>
  renderPluginComponent(ui, { id: 'pull-requests', plugin });

describe('resolvePullRequestState', () => {
  it('names an open pull request', () => {
    expect(resolvePullRequestState({ state: 'open', draft: false }).label).toBe('Open');
  });
  it('names a draft pull request', () => {
    expect(resolvePullRequestState({ state: 'open', draft: true }).label).toBe('Draft');
  });
  it('names a closed pull request', () => {
    expect(resolvePullRequestState({ state: 'closed', draft: false }).label).toBe('Closed');
  });
  it('names a merged pull request, draft or not', () => {
    expect(resolvePullRequestState({ state: 'merged', draft: true }).label).toBe('Merged');
  });
});

describe('PullRequestDiffStat', () => {
  it('renders nothing for no changes', async () => {
    const { container } = await render(<PullRequestDiffStat additions={0} deletions={0} />);
    expect(container.textContent).toBe('');
  });
  it('renders the counts with thousands separators', async () => {
    const view = await render(<PullRequestDiffStat additions={1234} deletions={5} />);
    expect(view.getByText('+1,234')).toBeTruthy();
    expect(view.getByText('-5')).toBeTruthy();
  });
});
