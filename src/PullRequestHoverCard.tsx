// The card a pull request chip shows while a mouse rests on it: the pull request at a glance. It
// only reads: it holds no control and takes no pointer, since a card's chip sits in a button.
import { useEffect, useLayoutEffect, useState } from 'react';
import { config, Portal, useTooltipContainer } from 'folds';
import { usePluginTranslation } from '@mindroom/client-sdk/core';
import { TriangleAlert } from 'lucide-react';
import {
  checksState,
  joinReviewers,
  latestReviewOutcomes,
  summarizeChecks,
  type Reviewer,
} from './detail/detail.logic';
import type { PullRequest, PullRequestCheck, PullRequestRef } from './github';
import { useGitHubErrorMessage } from './GitHubErrorState';
import { hoverCardPlacement, splitOverflow } from './hoverCard.logic';
import {
  PullRequestActorLabel,
  PullRequestDiffStat,
  PullRequestLabelChip,
  PullRequestMetaLine,
  PullRequestReviewerAvatar,
  pullRequestChecksStatePresentation,
  RelativeTime,
  resolvePullRequestState,
} from './presentation';
import { useReviews } from './queries';
import { pluginRootStyle } from './theme';
import { useGitHubToken } from './token';

/** How long a mouse rests on a chip before its card opens. */
export const HOVER_CARD_DELAY_MS = 150;

const FINE_POINTER = '(hover: hover) and (pointer: fine)';

// The most labels and reviewers the card shows before it counts the rest.
const SHOWN_LABELS = 5;
const SHOWN_REVIEWERS = 6;

/**
 * Whether the card of the chip `trigger` is open: from `HOVER_CARD_DELAY_MS` after a mouse came to
 * rest on it, or after the keyboard focused it (a `focusable` chip, a button), until the pointer
 * leaves, a click, a touch, Escape or the focus leaving. A mouse opens it only on a screen that
 * hovers with a fine pointer, and a tap never does: browsers send a mouseenter with each tap.
 */
export function useHoverCard(trigger: HTMLElement | null, focusable: boolean): boolean {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!trigger) return undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let touched = false;
    // Escape counts from when the card waits to open until it closes.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') hide();
    };
    const show = (still: () => boolean) => {
      clearTimeout(timer);
      document.addEventListener('keydown', onKeyDown);
      timer = setTimeout(() => (still() ? setOpen(true) : hide()), HOVER_CARD_DELAY_MS);
    };
    const hide = () => {
      clearTimeout(timer);
      document.removeEventListener('keydown', onKeyDown);
      setOpen(false);
    };
    // A tap sends its pointer events before the mouseenter it also sends.
    const onPointer = (event: PointerEvent) => {
      touched = event.pointerType === 'touch';
      if (touched) hide();
    };
    const byMouse = () => !touched && window.matchMedia?.(FINE_POINTER).matches === true;
    const onMouseEnter = () => {
      if (byMouse()) show(byMouse);
    };
    // A click or a tap focuses a button without the focus ring; the keyboard's focus shows it.
    const onFocus = () => {
      if (trigger.matches(':focus-visible')) show(() => true);
    };
    const listeners: [string, EventListener][] = [
      ['pointerenter', onPointer as EventListener],
      ['pointerdown', onPointer as EventListener],
      ['mouseenter', onMouseEnter],
      ['mouseleave', hide],
      ['click', hide],
      ...(focusable
        ? ([
            ['focus', onFocus],
            ['blur', hide],
          ] as [string, EventListener][])
        : []),
    ];
    for (const [type, listener] of listeners) trigger.addEventListener(type, listener);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('keydown', onKeyDown);
      for (const [type, listener] of listeners) trigger.removeEventListener(type, listener);
    };
  }, [trigger, focusable]);
  return open;
}

/**
 * Keeps `card` by its chip (`anchor`) and on screen: placed before the first paint, and again when
 * its content changes its size, the page scrolls or the window resizes.
 */
function usePlacement(anchor: HTMLElement, card: HTMLElement | null) {
  useLayoutEffect(() => {
    if (!card) return undefined;
    const place = () => {
      // Sized in rem, so the gap and the margin follow the page's zoom.
      const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      const { width, height } = card.getBoundingClientRect();
      const placement = hoverCardPlacement({
        anchor: anchor.getBoundingClientRect(),
        card: { width, height },
        viewport: { width: window.innerWidth, height: window.innerHeight },
        gap: 0.25 * rem,
        margin: 0.5 * rem,
        rightToLeft: getComputedStyle(anchor).direction === 'rtl',
      });
      // The edge it is not held by stays unset: set too, it would stretch the card to the chip.
      const px = (value: number | undefined) => (value === undefined ? '' : `${value}px`);
      Object.assign(card.style, {
        top: px(placement.top),
        bottom: px(placement.bottom),
        left: px(placement.left),
        maxHeight: px(placement.maxHeight),
        visibility: 'visible',
      });
    };
    place();
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(place);
    observer?.observe(card);
    const scroll = { capture: true, passive: true };
    window.addEventListener('scroll', place, scroll);
    window.addEventListener('resize', place);
    return () => {
      observer?.disconnect();
      window.removeEventListener('scroll', place, scroll);
      window.removeEventListener('resize', place);
    };
  }, [anchor, card]);
}

export function PullRequestHoverCard({
  id,
  anchor,
  pullRequest,
  pr,
  error,
  checks,
  opensPanel,
}: {
  id: string;
  anchor: HTMLElement;
  pullRequest: PullRequestRef;
  /** The chip's pull request, undefined until GitHub sent it. */
  pr: PullRequest | undefined;
  /** Why GitHub sent no pull request, if it refused. */
  error: unknown;
  /** The checks the chip asked for, undefined when it asks for none. */
  checks: { items: PullRequestCheck[] | undefined; failed: boolean } | undefined;
  /** Whether a click on the chip opens the pull request in the side panel. */
  opensPanel: boolean;
}) {
  const t = usePluginTranslation('pull-requests');
  const [card, setCard] = useState<HTMLDivElement | null>(null);
  usePlacement(anchor, card);
  const state = pr && resolvePullRequestState(pr);
  return (
    <Portal container={useTooltipContainer()}>
      <div
        ref={setCard}
        id={id}
        role="tooltip"
        className="mrpr-root mrpr-hover"
        style={{
          ...pluginRootStyle(),
          zIndex: config.zIndex.Max,
          boxShadow: config.shadow.E200,
          borderRadius: config.radii.R400,
        }}
      >
        <div className="mrpr-hover-head">
          <span className="mrpr-truncate">{`${pullRequest.owner}/${pullRequest.repo} #${pullRequest.number}`}</span>
          {state ? (
            <span className="mrpr-state">
              <state.Icon aria-hidden className={`mrpr-icon ${state.toneClassName}`} />
              {t(`state.${state.key}`)}
            </span>
          ) : null}
          {pr?.autoMerge ? (
            <span className="mrpr-badge mrpr-badge-outline">
              {t('badge.autoMerge', { method: pr.autoMerge.method })}
            </span>
          ) : null}
        </div>
        {pr ? (
          <Details pullRequest={pullRequest} pr={pr} checks={checks} />
        ) : error ? (
          <ErrorLine error={error} />
        ) : (
          <p className="mrpr-status">{t('loading')}</p>
        )}
        {opensPanel ? <p className="mrpr-hover-hint">{t('hoverCard.openInPanel')}</p> : null}
      </div>
    </Portal>
  );
}

function ErrorLine({ error }: { error: unknown }) {
  return <p className="mrpr-status">{useGitHubErrorMessage(error)}</p>;
}

function Details({
  pullRequest,
  pr,
  checks,
}: {
  pullRequest: PullRequestRef;
  pr: PullRequest;
  checks: { items: PullRequestCheck[] | undefined; failed: boolean } | undefined;
}) {
  const t = usePluginTranslation('pull-requests');
  const forkOwner =
    pr.headRepo && pr.headRepo !== pr.baseRepo ? pr.headRepo.split('/')[0] : undefined;
  // How the branch stands against its base matters only while the pull request can merge.
  const warning =
    pr.state !== 'open'
      ? undefined
      : pr.mergeableState === 'dirty'
      ? t('hoverCard.conflicts', { base: pr.baseRef })
      : pr.mergeableState === 'behind'
      ? t('hoverCard.behind', { base: pr.baseRef })
      : undefined;
  const ended =
    pr.state === 'merged' && pr.mergedAt
      ? { at: pr.mergedAt, key: 'hoverCard.merged' }
      : pr.state === 'closed' && pr.closedAt
      ? { at: pr.closedAt, key: 'hoverCard.closed' }
      : { at: pr.updatedAt, key: 'updated' };
  const labels = splitOverflow(pr.labels, SHOWN_LABELS);
  const changed = pr.additions > 0 || pr.deletions > 0;
  return (
    <>
      <p className="mrpr-hover-title">{pr.title}</p>
      <div className="mrpr-hover-people">
        <PullRequestMetaLine>
          <PullRequestActorLabel key="author" actor={pr.author} />
          <span key="opened" className="mrpr-shrink-0">
            <RelativeTime timestamp={pr.createdAt} label={(time) => t('opened', { time })} />
          </span>
          <span key="ended" className="mrpr-shrink-0">
            <RelativeTime timestamp={ended.at} label={(time) => t(ended.key, { time })} />
          </span>
        </PullRequestMetaLine>
      </div>
      <div className="mrpr-hover-branches">
        <span className="mrpr-truncate">
          {forkOwner ? `${forkOwner}:${pr.headRef}` : pr.headRef}
        </span>
        <span aria-hidden className="mrpr-shrink-0">
          →
        </span>
        <span className="mrpr-truncate">{pr.baseRef}</span>
      </div>
      {warning ? (
        <div className="mrpr-hover-base-warning">
          <TriangleAlert aria-hidden className="mrpr-icon mrpr-tone-warning" />
          {warning}
        </div>
      ) : null}
      <div className="mrpr-hover-size">
        <PullRequestMetaLine>
          {changed ? (
            <PullRequestDiffStat key="diff" additions={pr.additions} deletions={pr.deletions} />
          ) : null}
          <span key="files">{t('code.fileCount', { count: pr.changedFiles })}</span>
          <span key="commits">{t('timeline.commits', { count: pr.commitCount })}</span>
          <span key="comments">
            {t('timeline.comments', { count: pr.commentCount + pr.reviewCommentCount })}
          </span>
        </PullRequestMetaLine>
      </div>
      {checks && !checks.failed ? <ChecksRow items={checks.items} /> : null}
      <ReviewsRow pullRequest={pullRequest} pr={pr} />
      {labels.shown.length > 0 ? (
        <div className="mrpr-hover-labels">
          {labels.shown.map((label) => (
            <PullRequestLabelChip key={label.name} label={label} />
          ))}
          {labels.more > 0 ? (
            <span className="mrpr-hover-muted">
              {t('threadPullRequests.more', { count: labels.more })}
            </span>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

function ChecksRow({ items }: { items: PullRequestCheck[] | undefined }) {
  const t = usePluginTranslation('pull-requests');
  if (!items) {
    return <div className="mrpr-hover-checks mrpr-hover-muted">{t('checksLine.loading')}</div>;
  }
  const state = checksState(items);
  const mark = state === 'none' ? undefined : pullRequestChecksStatePresentation(state);
  const summary = summarizeChecks(items);
  return (
    <div className="mrpr-hover-checks">
      {mark ? <mark.Icon aria-hidden className={`mrpr-icon ${mark.toneClassName}`} /> : null}
      {t(`checks.${summary.key}`, summary)}
    </div>
  );
}

/**
 * Each reviewer's latest verdict and those still asked for a review, asked of GitHub only while
 * the card is open and only with a token, like the chip's checks: without one, GitHub's 60
 * requests an hour are kept for the pull requests and the panel. The row keeps its place while
 * they load, and goes without a token or when GitHub refuses.
 */
function ReviewsRow({ pullRequest, pr }: { pullRequest: PullRequestRef; pr: PullRequest }) {
  const t = usePluginTranslation('pull-requests');
  const { token } = useGitHubToken();
  const reviews = useReviews(pullRequest, token !== undefined);
  if (token === undefined || reviews.isError) return null;
  if (!reviews.data) {
    return (
      <div className="mrpr-hover-reviews mrpr-hover-muted">{t('summary.loadingReviewers')}</div>
    );
  }
  const reviewers = joinReviewers(
    latestReviewOutcomes(reviews.data.items, pr.headSha),
    pr.requestedReviewers
  );
  // Teams count among the six, so a long list cannot push the rows below out of the card.
  const { shown, more } = splitOverflow<Reviewer | string>(
    [...reviewers, ...pr.requestedTeams],
    SHOWN_REVIEWERS
  );
  if (shown.length === 0) {
    return <div className="mrpr-hover-reviews mrpr-hover-muted">{t('hoverCard.noReviews')}</div>;
  }
  return (
    <div className="mrpr-hover-reviews">
      {shown.map((entry) =>
        typeof entry === 'string' ? (
          <PullRequestLabelChip key={`team:${entry}`} label={{ name: entry, color: null }} />
        ) : (
          <PullRequestReviewerAvatar
            key={entry.key}
            reviewer={entry}
            pending={t('hoverCard.awaitingReview')}
          />
        )
      )}
      {more > 0 ? (
        <span className="mrpr-hover-muted">{t('threadPullRequests.more', { count: more })}</span>
      ) : null}
    </div>
  );
}
