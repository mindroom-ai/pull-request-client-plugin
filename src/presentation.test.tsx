// @vitest-environment jsdom
import { renderPluginComponent } from '@mindroom/client-sdk/testing';
import { describe, expect, it } from 'vitest';
import plugin from './index';
import {
  PullRequestDiffStat,
  resolvePullRequestState,
  PullRequestActorLabel,
  PullRequestCheckStatusIcon,
  PullRequestLabelChip,
  PullRequestReviewOutcomeBadge,
  PullRequestReviewOutcomeAvatarBadge,
  pullRequestChecksStatePresentation,
  pullRequestLabelColor,
  pullRequestReviewOutcomeRingClassName,
  PullRequestCheckStatusLabel,
} from './presentation';
import type { CheckStatus, PullRequestCheck } from './github';

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

const check = (status: CheckStatus, url: string | null = null): PullRequestCheck => ({
  name: 'build',
  status,
  description: null,
  url,
  updatedAt: null,
});

describe('PullRequestCheckStatusLabel', () => {
  it('names each status as T3 Code does, with an icon of its own', async () => {
    const statuses: [CheckStatus, string][] = [
      ['pending', 'Running'],
      ['action-required', 'Awaiting action'],
      ['success', 'Passed'],
      ['failure', 'Failed'],
      ['cancelled', 'Cancelled'],
      ['skipped', 'Skipped'],
      ['neutral', 'Neutral'],
    ];
    const view = await render(
      <ul>
        {statuses.map(([status]) => (
          <li key={status}>
            <PullRequestCheckStatusIcon status={status} />
            <PullRequestCheckStatusLabel check={check(status)} />
          </li>
        ))}
      </ul>
    );
    const items = [...view.container.querySelectorAll('li')];
    expect(items.map((item) => item.textContent)).toEqual(statuses.map(([, label]) => label));
    expect(items.map((item) => item.querySelector('svg')?.getAttribute('class'))).toHaveLength(7);
    expect(
      new Set(items.map((item) => item.querySelector('svg')?.getAttribute('data-check-status')))
        .size
    ).toBe(7);
  });

  it('asks a workflow run for approval rather than action', async () => {
    const run = 'https://github.com/a/b/actions/runs/12/job/34';
    const view = await render(
      <PullRequestCheckStatusLabel check={check('action-required', run)} />
    );
    expect(view.getByText('Awaiting approval')).toBeTruthy();
  });
});

describe('pullRequestChecksStatePresentation', () => {
  it('has a tone per state', () => {
    expect(pullRequestChecksStatePresentation('passing').toneClassName).toBe('mrpr-tone-success');
    expect(pullRequestChecksStatePresentation('failing').toneClassName).toBe('mrpr-tone-failure');
    expect(pullRequestChecksStatePresentation('pending').toneClassName).toBe('mrpr-tone-warning');
  });
});

describe('review outcomes', () => {
  it('rings an avatar by verdict, fainter when stale', () => {
    expect(pullRequestReviewOutcomeRingClassName('approved')).toBe('mrpr-ring-approved');
    expect(pullRequestReviewOutcomeRingClassName('changes-requested', true)).toBe(
      'mrpr-ring-changes-requested mrpr-ring-stale'
    );
  });

  it('labels the badge and draws the glyph on the avatar', async () => {
    const view = await render(
      <>
        <PullRequestReviewOutcomeBadge outcome="changes-requested" />
        <PullRequestReviewOutcomeAvatarBadge outcome="approved" stale />
      </>
    );
    expect(view.getByText('Changes requested')).toBeTruthy();
    expect(view.container.querySelector('svg.mrpr-outcome-badge')).toBeTruthy();
  });
});

describe('pullRequestLabelColor', () => {
  it('takes six hex digits, with or without the hash', () => {
    expect(pullRequestLabelColor('d73a4a')).toBe('#d73a4a');
    expect(pullRequestLabelColor(' #D73A4A ')).toBe('#D73A4A');
  });
  it('refuses anything else', () => {
    expect(pullRequestLabelColor('red')).toBeNull();
    expect(pullRequestLabelColor('fff')).toBeNull();
    expect(pullRequestLabelColor(null)).toBeNull();
  });
});

describe('PullRequestLabelChip', () => {
  it("shows the name in GitHub's color", async () => {
    const view = await render(<PullRequestLabelChip label={{ name: 'bug', color: 'd73a4a' }} />);
    const chip = view.getByText('bug').closest('.mrpr-label') as HTMLElement;
    expect(chip.style.getPropertyValue('--label')).toBe('#d73a4a');
  });
  it('sets no color for one GitHub gave badly', async () => {
    const view = await render(<PullRequestLabelChip label={{ name: 'odd', color: '' }} />);
    const chip = view.getByText('odd').closest('.mrpr-label') as HTMLElement;
    expect(chip.style.getPropertyValue('--label')).toBe('');
  });
});

describe('PullRequestActorLabel', () => {
  const actor = { login: 'octocat', name: 'The Octocat', avatarUrl: null, url: null, isBot: false };
  it('links the profile and names the person in its tooltip', async () => {
    const view = await render(
      <PullRequestActorLabel actor={actor} profileUrl="https://github.com/octocat" />
    );
    const link = view.getByRole('link') as HTMLAnchorElement;
    expect(link.href).toBe('https://github.com/octocat');
    expect(link.rel).toBe('noopener noreferrer');
    expect(link.getAttribute('aria-label')).toBe("Open octocat's profile");
    expect(link.title).toBe('The Octocat (@octocat) · Open profile');
    expect(view.getByText('octocat')).toBeTruthy();
  });
  it('shows only the login for one with no distinct name, and ghost for none', async () => {
    const view = await render(
      <>
        <PullRequestActorLabel actor={{ ...actor, name: 'octocat' }} />
        <PullRequestActorLabel actor={null} />
      </>
    );
    expect(view.container.querySelector('a')).toBeNull();
    expect(
      [...view.container.querySelectorAll('[title]')].map((e) => e.getAttribute('title'))
    ).toEqual(['octocat', 'ghost']);
  });
});
