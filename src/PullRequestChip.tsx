// A pull request in one line: its state's icon, its number and the mark of its checks. A thread's
// card draws it as a span inside the card's button; the strip under the room header as a button.
import { usePluginTranslation } from '@mindroom/client-sdk/core';
import { GitPullRequestArrow } from 'lucide-react';
import { checksState } from './detail/detail.logic';
import type { PullRequestRef } from './github';
import { pullRequestChecksStatePresentation, resolvePullRequestState } from './presentation';
import { useChecks, usePullRequest } from './queries';
import { pluginRootStyle } from './theme';

export function PullRequestChip({
  pullRequest,
  showRepository,
  selected,
  onSelect,
}: {
  pullRequest: PullRequestRef;
  /** Whether the repository's name shows before the number. */
  showRepository: boolean;
  selected?: boolean;
  /** Given, the chip is a button that calls it; absent, the chip is a span for a thread card. */
  onSelect?: () => void;
}) {
  const t = usePluginTranslation('pull-requests');
  const pr = usePullRequest(pullRequest).data;
  // Only an open pull request, draft or not, has checks worth asking for.
  const open = pr?.state === 'open';
  const checks = useChecks(pullRequest, pr?.headSha ?? '', open);
  const checksMark = open && checks.data ? checksState(checks.data.items) : 'none';
  const mark = checksMark === 'none' ? undefined : pullRequestChecksStatePresentation(checksMark);
  const state = pr && resolvePullRequestState(pr);
  // Until GitHub sent the pull request, or when it refused, the plain icon in the draft's tone.
  const StateIcon = state?.Icon ?? GitPullRequestArrow;
  const tone = state?.toneClassName ?? 'mrpr-tone-draft';
  const values = {
    repository: `${pullRequest.owner}/${pullRequest.repo}`,
    number: pullRequest.number,
  };
  const label = state
    ? t('chip.label', { ...values, state: t(`state.${state.key}`) })
    : t('chip.labelWithoutState', values);
  const name = pr?.title ? `${label}\n${pr.title}` : label;
  // The chip is drawn outside the card and the panel, so it sets the variables it draws with.
  const root = {
    className: selected ? 'mrpr-chip mrpr-chip-selected' : 'mrpr-chip',
    style: pluginRootStyle(),
    'aria-label': name,
    title: name,
  };
  const content = (
    <>
      <StateIcon aria-hidden className={`mrpr-icon ${tone}`} />
      {showRepository ? <span className="mrpr-chip-repo">{pullRequest.repo}</span> : null}
      <span>#{pullRequest.number}</span>
      {mark ? (
        <mark.Icon aria-hidden className={`mrpr-icon mrpr-chip-checks ${mark.toneClassName}`} />
      ) : null}
    </>
  );
  return onSelect ? (
    <button {...root} type="button" aria-pressed={selected} onClick={onSelect}>{content}</button>
  ) : (
    <span {...root} role="img">{content}</span>
  );
}
