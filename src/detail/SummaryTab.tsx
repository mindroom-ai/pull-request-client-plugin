// Ported from T3 Code (https://github.com/pingdotgg/t3code, apps/web/src/components/pullRequest/PullRequestSummaryTab.tsx and PullRequestMoreReplies.tsx at 8ab427c6), MIT, Copyright (c) 2026 T3 Tools Inc. See NOTICE.
// The Summary tab: who reviewed and what they decided, the labels, the description, the checks and
// the conversation. Each list has its own query, so a failure shows in its own place and the rest
// keeps working.
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from 'react';
import FocusTrap from 'focus-trap-react';
import type { RectCords } from 'folds';
import { ArrowDownUp, ChevronRight, ListFilter, Tag, Users } from 'lucide-react';
import { usePluginStorage, usePluginTranslation } from '@mindroom/client-sdk/core';
import { Menu, PopOut, useMarkdownHtml } from '@mindroom/client-sdk/ui';
import type { Actor, Paged, PullRequest, PullRequestRef, Review } from '../github';
import { GitHubErrorState } from '../GitHubErrorState';
import {
  PullRequestActorAvatar,
  PullRequestCheckStatusIcon,
  PullRequestCheckStatusLabel,
  PullRequestLabelChip,
  PullRequestReviewOutcomeAvatarBadge,
  pullRequestReviewOutcomeRingClassName,
  usePullRequestReviewOutcomeLabel,
} from '../presentation';
import { useChecks, useConversationComments, useReviewComments, useReviews } from '../queries';
import { buildReviewThreads } from '../reviewThreads';
import { pluginRootStyle } from '../theme';
import { MenuOption } from './CommitSelector';
import { ConversationCard } from './ConversationCards';
import { TruncatedNote } from './TruncatedNote';
import {
  conversationItems,
  filterConversationItems,
  latestReviewOutcomes,
  type ConversationItem,
  type Outcome,
} from './detail.logic';

const PAGE = 10;
const SHOW_BOTS_KEY = 'summary:showBots';

type Order = 'newest' | 'oldest';

/** A collapsible part of the tab; its heading stays at the top of the scrolling tab. */
function Section({
  title,
  defaultOpen = true,
  keepMounted = false,
  actions,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  /** Keeps the body in the page, hidden, while the section is closed. */
  keepMounted?: boolean;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const bodyId = useId();
  return (
    <section aria-label={title} className="mrpr-section">
      <div className="mrpr-section-heading">
        <button
          type="button"
          className="mrpr-section-toggle"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen(!open)}
        >
          <span>{title}</span>
          <ChevronRight
            aria-hidden
            className={`mrpr-icon mrpr-chevron${open ? ' mrpr-chevron-open' : ''}`}
          />
        </button>
        {actions}
      </div>
      {open || keepMounted ? (
        <div id={bodyId} hidden={!open} className="mrpr-section-body">
          {children}
        </div>
      ) : null}
    </section>
  );
}

function MetaRow({
  icon,
  label,
  children,
}: {
  icon: ReactNode;
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="mrpr-meta-row">
      <span className="mrpr-meta-row-label">
        {icon}
        {label}
      </span>
      <span className="mrpr-meta-row-value">{children}</span>
    </div>
  );
}

type Reviewer = {
  key: string;
  actor: Actor | null;
  outcome: Outcome | null;
  stale: boolean;
};

// GitHub's login casing varies between its lists.
const reviewerKey = (login: string) => login.toLowerCase();

/** The reviewers' avatars: those asked and those who gave a verdict, a ring and a glyph for each verdict. */
function ReviewersRow({
  pullRequest,
  reviews,
  retry,
  error,
}: {
  pullRequest: PullRequest;
  reviews: Paged<Review> | undefined;
  error: unknown;
  retry: () => void;
}) {
  const t = usePluginTranslation('pull-requests');
  const outcomeLabel = usePullRequestReviewOutcomeLabel();
  const outcomes = useMemo(
    () => (reviews ? latestReviewOutcomes(reviews.items, pullRequest.headSha) : []),
    [reviews, pullRequest.headSha]
  );
  const byLogin = new Map(
    outcomes.flatMap((entry) =>
      entry.actor ? [[reviewerKey(entry.actor.login), entry] as const] : []
    )
  );
  // GitHub drops a reviewer from the requested ones once they review, so the verdicts of others join.
  const entries: Reviewer[] = [
    ...pullRequest.requestedReviewers.map((actor) => {
      const entry = byLogin.get(reviewerKey(actor.login));
      return {
        key: actor.login,
        actor,
        outcome: entry?.verdict ?? null,
        stale: entry?.stale ?? false,
      };
    }),
    ...outcomes
      .filter(
        (entry) =>
          !entry.actor ||
          !pullRequest.requestedReviewers.some(
            (actor) => reviewerKey(actor.login) === reviewerKey(entry.actor?.login ?? '')
          )
      )
      .map((entry) => ({
        key: entry.login,
        actor: entry.actor,
        outcome: entry.verdict,
        stale: entry.stale,
      })),
  ];
  const nothing = entries.length === 0 && pullRequest.requestedTeams.length === 0;
  return (
    <MetaRow icon={<Users aria-hidden className="mrpr-icon" />} label={t('summary.reviewers')}>
      <span className="mrpr-reviewers">
        {nothing ? (
          <span className="mrpr-status">
            {reviews || error ? t('summary.none') : t('summary.loadingReviewers')}
          </span>
        ) : (
          <span className="mrpr-avatars">
            {entries.map((entry) => {
              const login = entry.actor?.login ?? t('ghost');
              const name =
                entry.actor?.name && entry.actor.name !== login
                  ? t('actor.tooltip', { name: entry.actor.name, login })
                  : login;
              const label = entry.outcome ? outcomeLabel(entry.outcome, entry.stale) : null;
              return (
                <span
                  key={entry.key}
                  className={`mrpr-reviewer${
                    entry.outcome
                      ? ` ${pullRequestReviewOutcomeRingClassName(entry.outcome, entry.stale)}`
                      : ''
                  }`}
                  title={label ? t('summary.reviewerTitle', { name, outcome: label }) : name}
                >
                  <PullRequestActorAvatar actor={entry.actor} />
                  <span className="mrpr-sr-only">{login}</span>
                  {entry.outcome ? (
                    <>
                      <PullRequestReviewOutcomeAvatarBadge
                        outcome={entry.outcome}
                        stale={entry.stale}
                      />
                      <span className="mrpr-sr-only">{label}</span>
                    </>
                  ) : null}
                </span>
              );
            })}
          </span>
        )}
        {pullRequest.requestedTeams.map((team) => (
          <PullRequestLabelChip key={`team:${team}`} label={{ name: team, color: null }} />
        ))}
      </span>
      {error ? <GitHubErrorState compact error={error} onRetry={retry} /> : null}
      {reviews?.truncated ? (
        <TruncatedNote
          label={t('summary.truncated', { count: reviews.items.length })}
          href={pullRequest.url}
        />
      ) : null}
    </MetaRow>
  );
}

function Description({ body }: { body: string }) {
  const t = usePluginTranslation('pull-requests');
  const html = useMarkdownHtml(body);
  if (body.trim() === '') return <p className="mrpr-status">{t('noDescription')}</p>;
  if (html === undefined) return null;
  return <div className="mrpr-description" dangerouslySetInnerHTML={{ __html: html }} />;
}

/** The checks of the head commit, one row each; loaded once the section is open. */
function ChecksList({
  pullRequest,
  pullRequestRef,
}: {
  pullRequest: PullRequest;
  pullRequestRef: PullRequestRef;
}) {
  const t = usePluginTranslation('pull-requests');
  const query = useChecks(pullRequestRef, pullRequest.headSha, true);
  if (query.isError) {
    return <GitHubErrorState compact error={query.error} onRetry={() => void query.refetch()} />;
  }
  if (!query.data) return <p className="mrpr-status">{t('summary.loadingChecks')}</p>;
  const checks = query.data.items;
  if (checks.length === 0) return <p className="mrpr-status">{t('summary.noChecks')}</p>;
  return (
    <>
      <ul className="mrpr-checks mrpr-checks-with-details">
        {checks.map((check, index) => (
          // Check names can repeat, and these rows hold no state of their own.
          // eslint-disable-next-line react/no-array-index-key
          <li key={`${index}:${check.name}`} className="mrpr-check">
            <PullRequestCheckStatusIcon status={check.status} />
            <span className="mrpr-check-name mrpr-truncate" title={check.description ?? check.name}>
              {check.name}
            </span>
            <span className="mrpr-check-status">
              <PullRequestCheckStatusLabel check={check} />
            </span>
            {check.url === null ? null : (
              <a className="mrpr-link" href={check.url} target="_blank" rel="noopener noreferrer">
                {t('checksPopover.details')}
              </a>
            )}
          </li>
        ))}
      </ul>
      {query.data.truncated ? (
        <TruncatedNote
          label={t('summary.truncated', { count: checks.length })}
          href={`${pullRequest.url}/checks`}
        />
      ) : null}
    </>
  );
}

const commentsIn = (item: ConversationItem) =>
  item.kind === 'thread' ? item.thread.comments.length : 1;

/** The filter's menu: what the comments list shows, kept in the plugin's storage. */
function FilterMenu({
  hidden,
  showBots,
  onShowBots,
}: {
  hidden: number;
  showBots: boolean;
  onShowBots: (show: boolean) => void;
}) {
  const t = usePluginTranslation('pull-requests');
  const [anchor, setAnchor] = useState<RectCords>();
  const buttonRef = useRef<HTMLButtonElement>(null);
  // Set when Escape closes the menu, which then gives the focus back to its button. That waits
  // until the menu is gone: while its focus trap is active, the trap takes the focus back. A click
  // outside leaves the focus where it went.
  const refocus = useRef(false);
  useEffect(() => {
    if (anchor !== undefined || !refocus.current) return;
    refocus.current = false;
    buttonRef.current?.focus();
  }, [anchor]);
  const label = t('summary.filterLabel');
  // Escape and a click outside close it, as the app's own menus do.
  const close = () => {
    setAnchor(undefined);
    return true;
  };
  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="mrpr-button mrpr-button-quiet"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={anchor !== undefined}
        onClick={(event: MouseEvent<HTMLButtonElement>) =>
          setAnchor(anchor ? undefined : event.currentTarget.getBoundingClientRect())
        }
      >
        <ListFilter aria-hidden className="mrpr-icon" />
        {hidden > 0 ? t('summary.hidden', { count: hidden }) : t('summary.filter')}
      </button>
      <PopOut
        anchor={anchor}
        position="Bottom"
        align="End"
        offset={4}
        content={
          <FocusTrap
            focusTrapOptions={{
              initialFocus: false,
              returnFocusOnDeactivate: false,
              clickOutsideDeactivates: close,
              escapeDeactivates: () => {
                refocus.current = true;
                return close();
              },
            }}
          >
            <Menu role="menu" aria-label={label}>
              {/* A switch leaves the menu open, as the diff options' switches do. */}
              <div
                className="mrpr-root mrpr-commit-menu mrpr-options-menu"
                style={pluginRootStyle()}
              >
                <MenuOption
                  role="menuitemcheckbox"
                  checked={showBots}
                  onSelect={() => onShowBots(!showBots)}
                >
                  {t('summary.showBots')}
                </MenuOption>
              </div>
            </Menu>
          </FocusTrap>
        }
      />
    </>
  );
}

export function SummaryTab({
  pullRequest,
  pullRequestRef,
}: {
  pullRequest: PullRequest;
  pullRequestRef: PullRequestRef;
}) {
  const t = usePluginTranslation('pull-requests');
  const storage = usePluginStorage('pull-requests');
  const [showBots, setShowBots] = useState(() => storage.getItem(SHOW_BOTS_KEY) === 'true');
  const [order, setOrder] = useState<Order>('newest');
  const [shown, setShown] = useState(PAGE);
  const reviews = useReviews(pullRequestRef, true);
  const comments = useConversationComments(pullRequestRef, true);
  const reviewComments = useReviewComments(pullRequestRef, true);

  const threads = useMemo(
    () => buildReviewThreads(reviewComments.data?.items ?? []),
    [reviewComments.data]
  );
  // Oldest first: the window of the latest conversations is its end.
  const items = useMemo(
    () =>
      conversationItems(comments.data?.items ?? [], reviews.data?.items ?? [], threads, 'oldest'),
    [comments.data, reviews.data, threads]
  );
  const visible = filterConversationItems(items, { bots: showBots });
  const total = items.reduce((sum, item) => sum + commentsIn(item), 0);
  const hiddenComments = total - visible.reduce((sum, item) => sum + commentsIn(item), 0);
  const recent = visible.slice(Math.max(0, visible.length - shown));
  const older = visible.length - recent.length;
  const listed = order === 'newest' ? [...recent].reverse() : recent;
  const loading = [comments, reviewComments, reviews].some((query) => query.isPending);

  const olderButton =
    older > 0 ? (
      <button
        type="button"
        className="mrpr-button mrpr-button-wide"
        onClick={() => setShown(shown + PAGE)}
      >
        {t('summary.olderConversations', { count: Math.min(older, PAGE) })}
      </button>
    ) : null;

  const chooseShowBots = (show: boolean) => {
    setShowBots(show);
    storage.setItem(SHOW_BOTS_KEY, String(show));
  };

  return (
    <div className="mrpr-summary">
      <section className="mrpr-summary-meta">
        <ReviewersRow
          pullRequest={pullRequest}
          reviews={reviews.data}
          error={reviews.isError ? reviews.error : undefined}
          retry={() => void reviews.refetch()}
        />
        {pullRequest.labels.length > 0 ? (
          <MetaRow icon={<Tag aria-hidden className="mrpr-icon" />} label={t('summary.labels')}>
            <span className="mrpr-labels">
              {pullRequest.labels.map((label) => (
                <PullRequestLabelChip key={label.name} label={label} />
              ))}
            </span>
          </MetaRow>
        ) : null}
      </section>

      <Section title={t('summary.description')} keepMounted>
        <Description body={pullRequest.body} />
      </Section>

      <Section title={t('summary.checks')} defaultOpen={false}>
        <ChecksList pullRequest={pullRequest} pullRequestRef={pullRequestRef} />
      </Section>

      <Section
        title={t('summary.comments', {
          count: pullRequest.commentCount + pullRequest.reviewCommentCount,
        })}
        actions={
          <div className="mrpr-section-actions">
            <FilterMenu hidden={hiddenComments} showBots={showBots} onShowBots={chooseShowBots} />
            <button
              type="button"
              className="mrpr-button mrpr-button-quiet"
              onClick={() => setOrder(order === 'newest' ? 'oldest' : 'newest')}
            >
              <ArrowDownUp aria-hidden className="mrpr-icon" />
              {t(order === 'newest' ? 'summary.newestFirst' : 'summary.oldestFirst')}
            </button>
          </div>
        }
      >
        {comments.isError ? (
          <GitHubErrorState
            compact
            error={comments.error}
            onRetry={() => void comments.refetch()}
          />
        ) : null}
        {reviewComments.isError ? (
          <GitHubErrorState
            compact
            error={reviewComments.error}
            onRetry={() => void reviewComments.refetch()}
          />
        ) : null}
        {comments.data?.truncated ? (
          <TruncatedNote
            label={t('summary.truncated', { count: comments.data.items.length })}
            href={pullRequest.url}
          />
        ) : null}
        {reviewComments.data?.truncated ? (
          <TruncatedNote
            label={t('summary.truncated', { count: reviewComments.data.items.length })}
            href={pullRequest.url}
          />
        ) : null}
        {loading ? (
          <p className="mrpr-status">{t('summary.loadingComments')}</p>
        ) : items.length === 0 ? (
          comments.isError || reviewComments.isError ? null : (
            <p className="mrpr-status">{t('summary.noComments')}</p>
          )
        ) : visible.length === 0 ? (
          <p className="mrpr-status">{t('summary.allHidden', { count: hiddenComments })}</p>
        ) : (
          <div className="mrpr-conversations">
            {order === 'oldest' ? olderButton : null}
            {listed.map((item) => (
              <ConversationCard key={itemKey(item)} item={item} />
            ))}
            {order === 'newest' ? olderButton : null}
          </div>
        )}
      </Section>
    </div>
  );
}

const itemKey = (item: ConversationItem) =>
  item.kind === 'comment'
    ? `comment:${item.comment.id}`
    : item.kind === 'review'
    ? `review:${item.review.id}`
    : `thread:${item.thread.id}`;
