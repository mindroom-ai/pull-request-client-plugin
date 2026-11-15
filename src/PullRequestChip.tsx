// A pull request in one line: its state's icon, its number and the mark of its checks. A thread's
// card draws it as a span inside the card's button; the strip under the room header as a button.
import { useEffect, useState } from 'react';
import { usePluginTranslation } from '@mindroom/client-sdk/core';
import { GitPullRequestArrow } from 'lucide-react';
import { checksState } from './detail/detail.logic';
import type { PullRequestRef } from './github';
import { pullRequestChecksStatePresentation, resolvePullRequestState } from './presentation';
import { useChecks, usePullRequest } from './queries';
import { pluginRootStyle } from './theme';
import { useGitHubToken } from './token';

/** Whether `element` has been on screen; at once where the browser cannot tell. */
function useOnScreenOnce(element: Element | null): boolean {
  const [seen, setSeen] = useState(() => typeof IntersectionObserver === 'undefined');
  useEffect(() => {
    if (seen || element === null) return undefined;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setSeen(true);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [element, seen]);
  return seen;
}

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
  const [element, setElement] = useState<HTMLElement | null>(null);
  // The Compact view draws every card of a room: a chip asks GitHub once it has been on screen.
  const queried = useOnScreenOnce(element) ? pullRequest : undefined;
  const pr = usePullRequest(queried).data;
  const { token } = useGitHubToken();
  // Only an open pull request, draft or not, has checks worth asking for, and only with a token:
  // without one, GitHub allows 60 requests an hour, kept for the pull requests and the panel.
  const withChecks = pr?.state === 'open' && token !== undefined;
  const checks = useChecks(queried, pr?.headSha ?? '', withChecks);
  const checksMark = withChecks && checks.data ? checksState(checks.data.items) : 'none';
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
    ref: setElement,
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
    <button {...root} type="button" aria-pressed={selected} onClick={onSelect}>
      {content}
    </button>
  ) : (
    <span {...root} role="img">
      {content}
    </span>
  );
}
