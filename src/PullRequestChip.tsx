// A pull request in one line: its state's icon, its number and the mark of its checks, with a card
// of its details while a mouse rests on it. A thread's card draws it as a span inside the card's
// button.
import { useEffect, useId, useState } from 'react';
import { usePluginTranslation } from '@mindroom/client-sdk/core';
import { GitPullRequestArrow } from 'lucide-react';
import type { PullRequestRef } from './github';
import { PullRequestHoverCard, useHoverCard } from './PullRequestHoverCard';
import { pullRequestChecksStatePresentation } from './presentation';
import { usePullRequestStatus } from './pullRequestStatus';
import { chipRefetch } from './queries';
import { pluginRootStyle } from './theme';

// Wait past the host's 280 ms page slide and 260 ms swipe settle.
const VISIBILITY_SETTLE_MS = 300;

/** Latches after continuous intersection, or immediately if the browser cannot observe it. */
export function useSettledVisibility(element: Element | null): boolean {
  const [settled, setSettled] = useState(() => typeof IntersectionObserver === 'undefined');
  useEffect(() => {
    if (settled || element === null) return undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let observing = true;
    const observer = new IntersectionObserver((entries) => {
      if (!observing) return;
      // An exit breaks the dwell even if another entry in the same batch re-enters.
      if (entries.some((entry) => !entry.isIntersecting)) {
        clearTimeout(timer);
        timer = undefined;
      }
      if (entries.at(-1)?.isIntersecting) {
        timer ??= setTimeout(() => setSettled(true), VISIBILITY_SETTLE_MS);
      }
    });
    observer.observe(element);
    return () => {
      observing = false;
      observer.disconnect();
      clearTimeout(timer);
    };
  }, [element, settled]);
  return settled;
}

export function PullRequestChip({
  pullRequest,
  showRepository,
  opensPanel = false,
}: {
  pullRequest: PullRequestRef;
  /** Whether the repository's name shows before the number. */
  showRepository: boolean;
  /** Whether a click on a thread card's chip opens the pull request in the side panel. */
  opensPanel?: boolean;
}) {
  const t = usePluginTranslation('pull-requests');
  const [element, setElement] = useState<HTMLElement | null>(null);
  const settled = useSettledVisibility(element);
  // The hover card stands in for a title, which would show a second tooltip, a slow one.
  const hoverCardOpen = useHoverCard(element);
  const { pr, state, checks, error, checkList } = usePullRequestStatus(
    pullRequest,
    chipRefetch(settled, hoverCardOpen)
  );
  const mark = checks && pullRequestChecksStatePresentation(checks);
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
  const hoverCardId = useId();
  // The chip is drawn outside the card and the panel, so it sets the variables it draws with.
  return (
    <>
      <span
        ref={setElement}
        className="mrpr-chip"
        style={pluginRootStyle()}
        aria-label={name}
        role="img"
      >
        <StateIcon aria-hidden className={`mrpr-icon ${tone}`} />
        {showRepository ? <span className="mrpr-chip-repo">{pullRequest.repo}</span> : null}
        <span>#{pullRequest.number}</span>
        {mark ? (
          <mark.Icon aria-hidden className={`mrpr-icon mrpr-chip-checks ${mark.toneClassName}`} />
        ) : null}
      </span>
      {hoverCardOpen && element ? (
        <PullRequestHoverCard
          id={hoverCardId}
          anchor={element}
          pullRequest={pullRequest}
          pr={pr}
          error={error}
          checks={checkList}
          opensPanel={opensPanel}
        />
      ) : null}
    </>
  );
}
