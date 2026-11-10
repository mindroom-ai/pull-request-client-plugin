// Ported from T3 Code (https://github.com/pingdotgg/t3code, apps/web/src/components/pullRequest/pullRequestIcons.tsx and pullRequestPresentation.tsx at 8ab427c6), MIT, Copyright (c) 2026 T3 Tools Inc. See NOTICE.
// How a pull request's state, author, diff counts and age look, shared by the card and the panel.
import { Children, isValidElement, useState, type CSSProperties, type ReactNode } from 'react';
import { usePluginTranslation } from '@mindroom/client-sdk/core';
import {
  CircleCheck,
  CircleDashed,
  CircleDot,
  CircleSlash,
  CircleX,
  GitMerge,
  GitPullRequestArrow,
  GitPullRequestClosed,
  GitPullRequestDraft,
  LoaderCircle,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { isWorkflowApprovalCheck, type ChecksState, type Outcome } from './detail/detail.logic';
import type { Actor, CheckStatus, PullRequest, PullRequestCheck } from './github';

export const PULL_REQUEST_STATE_PRESENTATION = {
  open: {
    key: 'open',
    label: 'Open',
    toneClassName: 'mrpr-tone-open',
    Icon: GitPullRequestArrow,
  },
  draft: {
    key: 'draft',
    label: 'Draft',
    toneClassName: 'mrpr-tone-draft',
    Icon: GitPullRequestDraft,
  },
  closed: {
    key: 'closed',
    label: 'Closed',
    toneClassName: 'mrpr-tone-closed',
    Icon: GitPullRequestClosed,
  },
  merged: {
    key: 'merged',
    label: 'Merged',
    toneClassName: 'mrpr-tone-merged',
    Icon: GitMerge,
  },
} as const;

export type PullRequestStatePresentation =
  (typeof PULL_REQUEST_STATE_PRESENTATION)[keyof typeof PULL_REQUEST_STATE_PRESENTATION];

export function resolvePullRequestState(input: {
  state: PullRequest['state'];
  draft: boolean;
}): PullRequestStatePresentation {
  const key = input.state === 'open' && input.draft ? 'draft' : input.state;
  return PULL_REQUEST_STATE_PRESENTATION[key];
}

/** The app's language, which numbers and relative times are formatted in. */
function useLanguage(): string | undefined {
  return useTranslation().i18n.resolvedLanguage;
}

export function PullRequestActorAvatar({
  actor,
}: {
  actor: { login: string; avatarUrl: string | null } | null;
}) {
  const login = actor?.login ?? 'ghost';
  const avatarUrl = actor?.avatarUrl ?? null;
  const [failedAvatarUrl, setFailedAvatarUrl] = useState<string | null>(null);
  return avatarUrl === null || failedAvatarUrl === avatarUrl ? (
    <span aria-hidden className="mrpr-avatar">
      {login.slice(0, 1).toUpperCase()}
    </span>
  ) : (
    <img
      aria-hidden
      alt=""
      // Set before `src`, so the request for the image already sends no referrer.
      referrerPolicy="no-referrer"
      src={avatarUrl}
      loading="lazy"
      className="mrpr-avatar"
      onError={() => setFailedAvatarUrl(avatarUrl)}
    />
  );
}

export function PullRequestDiffStat({
  additions,
  deletions,
}: {
  additions: number;
  deletions: number;
}) {
  const language = useLanguage();
  if (additions === 0 && deletions === 0) return null;
  const format = new Intl.NumberFormat(language);
  return (
    <span className="mrpr-diffstat">
      <span className="mrpr-added">+{format.format(additions)}</span>
      <span className="mrpr-removed">-{format.format(deletions)}</span>
    </span>
  );
}

function separatorKey(segment: ReactNode): string {
  return `separator:${isValidElement(segment) ? String(segment.key) : String(segment)}`;
}

export function PullRequestMetaLine({ children }: { children: ReactNode }) {
  const segments = Children.toArray(children);
  return (
    <span className="mrpr-meta">
      {segments.flatMap((segment, index) =>
        index === 0
          ? segment
          : [
              <span aria-hidden className="mrpr-separator" key={separatorKey(segment)}>
                ·
              </span>,
              segment,
            ]
      )}
    </span>
  );
}

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 86_400],
  ['month', 30 * 86_400],
  ['week', 7 * 86_400],
  ['day', 86_400],
  ['hour', 3_600],
  ['minute', 60],
];

/** "3 days ago" in `language`; an empty string for a timestamp that is no date. */
export function formatRelativeTime(
  timestamp: string,
  language: string | undefined,
  now = Date.now()
) {
  const time = Date.parse(timestamp);
  if (Number.isNaN(time)) return '';
  const seconds = Math.round((time - now) / 1000);
  const format = new Intl.RelativeTimeFormat(language, { numeric: 'auto' });
  const [unit, size] = UNITS.find(([, size]) => Math.abs(seconds) >= size) ?? ['second', 1];
  return format.format(Math.round(seconds / size), unit);
}

/** A moment as its age, with the date itself as its tooltip; `label` wraps the age in a sentence. */
export function RelativeTime({
  timestamp,
  label,
}: {
  timestamp: string;
  label?: (relative: string) => string;
}) {
  const language = useLanguage();
  const relative = formatRelativeTime(timestamp, language);
  if (relative === '') return null;
  return (
    <time dateTime={timestamp} title={new Date(timestamp).toLocaleString(language)}>
      {label ? label(relative) : relative}
    </time>
  );
}

const CHECK_STATUS_PRESENTATION = {
  pending: { key: 'pending', Icon: LoaderCircle, toneClassName: 'mrpr-tone-warning mrpr-spin' },
  'action-required': {
    key: 'actionRequired',
    Icon: CircleDot,
    toneClassName: 'mrpr-tone-warning',
  },
  success: { key: 'success', Icon: CircleCheck, toneClassName: 'mrpr-tone-success' },
  failure: { key: 'failure', Icon: CircleX, toneClassName: 'mrpr-tone-failure' },
  cancelled: { key: 'cancelled', Icon: CircleX, toneClassName: 'mrpr-tone-failure' },
  skipped: { key: 'skipped', Icon: CircleSlash, toneClassName: 'mrpr-tone-muted' },
  neutral: { key: 'neutral', Icon: CircleDashed, toneClassName: 'mrpr-tone-muted' },
} as const satisfies Record<CheckStatus, { key: string; Icon: unknown; toneClassName: string }>;

export function PullRequestCheckStatusIcon({ status }: { status: CheckStatus }) {
  const presentation = CHECK_STATUS_PRESENTATION[status];
  return (
    <presentation.Icon
      aria-hidden
      data-check-status={status}
      className={`mrpr-icon ${presentation.toneClassName}`}
    />
  );
}

/** What a check is doing, in words; a workflow run that waits for a click asks for approval. */
export function PullRequestCheckStatusLabel({
  check,
}: {
  check: Pick<PullRequestCheck, 'status' | 'url'>;
}) {
  const t = usePluginTranslation('pull-requests');
  const key = isWorkflowApprovalCheck(check)
    ? 'awaitingApproval'
    : CHECK_STATUS_PRESENTATION[check.status].key;
  return <>{t(`checkStatus.${key}`)}</>;
}

const CHECKS_STATE_PRESENTATION = {
  passing: { Icon: CircleCheck, toneClassName: 'mrpr-tone-success' },
  failing: { Icon: CircleX, toneClassName: 'mrpr-tone-failure' },
  pending: { Icon: CircleDot, toneClassName: 'mrpr-tone-warning' },
} as const satisfies Record<Exclude<ChecksState, 'none'>, unknown>;

/** The icon and tone of the checks taken together; the words are `checksState.<state>`. */
export function pullRequestChecksStatePresentation(state: Exclude<ChecksState, 'none'>) {
  return CHECKS_STATE_PRESENTATION[state];
}

const REVIEW_OUTCOME_PRESENTATION = {
  approved: {
    key: 'approved',
    Icon: CircleCheck,
    toneClassName: 'mrpr-tone-success',
    ringClassName: 'mrpr-ring-approved',
    badgeClassName: 'mrpr-badge-success',
  },
  'changes-requested': {
    key: 'changesRequested',
    Icon: CircleX,
    toneClassName: 'mrpr-tone-failure',
    ringClassName: 'mrpr-ring-changes-requested',
    badgeClassName: 'mrpr-badge-error',
  },
  dismissed: {
    key: 'dismissed',
    Icon: CircleDashed,
    toneClassName: 'mrpr-tone-muted',
    ringClassName: 'mrpr-ring-dismissed',
    badgeClassName: 'mrpr-badge-outline',
  },
} as const satisfies Record<Outcome, unknown>;

export function pullRequestReviewOutcomeToneClassName(outcome: Outcome): string {
  return REVIEW_OUTCOME_PRESENTATION[outcome].toneClassName;
}

/** The ring around a reviewer's avatar; a verdict on an earlier commit is a fainter mix. */
export function pullRequestReviewOutcomeRingClassName(outcome: Outcome, stale = false): string {
  const { ringClassName } = REVIEW_OUTCOME_PRESENTATION[outcome];
  return stale ? `${ringClassName} mrpr-ring-stale` : ringClassName;
}

/** "Approved" and the like, or for a verdict on an earlier commit, "Approved earlier changes". */
export function usePullRequestReviewOutcomeLabel(): (outcome: Outcome, stale?: boolean) => string {
  const t = usePluginTranslation('pull-requests');
  return (outcome, stale = false) =>
    t(
      `${stale ? 'reviewOutcomeStale' : 'reviewOutcome'}.${
        REVIEW_OUTCOME_PRESENTATION[outcome].key
      }`
    );
}

export function PullRequestReviewOutcomeIcon({
  outcome,
  className = '',
}: {
  outcome: Outcome;
  className?: string;
}) {
  const presentation = REVIEW_OUTCOME_PRESENTATION[outcome];
  return (
    <presentation.Icon
      aria-hidden
      className={`mrpr-icon ${presentation.toneClassName} ${className}`.trim()}
    />
  );
}

/** A glyph on the avatar's corner: a ring's color alone blends into a colorful bot's avatar. */
export function PullRequestReviewOutcomeAvatarBadge({
  outcome,
  stale = false,
}: {
  outcome: Outcome;
  stale?: boolean;
}) {
  const presentation = REVIEW_OUTCOME_PRESENTATION[outcome];
  return (
    <presentation.Icon
      aria-hidden
      strokeWidth={3}
      className={`mrpr-outcome-badge ${presentation.toneClassName}${
        stale ? ' mrpr-outcome-badge-stale' : ''
      }`}
    />
  );
}

export function PullRequestReviewOutcomeBadge({ outcome }: { outcome: Outcome }) {
  const label = usePullRequestReviewOutcomeLabel();
  const presentation = REVIEW_OUTCOME_PRESENTATION[outcome];
  return (
    <span className={`mrpr-badge ${presentation.badgeClassName}`}>
      <presentation.Icon aria-hidden className="mrpr-icon" />
      <span>{label(outcome)}</span>
    </span>
  );
}

/** `#rrggbb` for the six hex digits of GitHub's label color, with or without a hash. */
export function pullRequestLabelColor(color: string | null): string | null {
  const hex = color?.trim().replace(/^#/, '') ?? '';
  return /^[0-9a-fA-F]{6}$/.test(hex) ? `#${hex}` : null;
}

export function PullRequestLabelChip({
  label,
  children,
}: {
  label: { name: string; color: string | null };
  children?: ReactNode;
}) {
  const color = pullRequestLabelColor(label.color);
  return (
    <span
      className="mrpr-label"
      style={color ? ({ '--label': color } as CSSProperties) : undefined}
    >
      <span className="mrpr-truncate">{label.name}</span>
      {children}
    </span>
  );
}

/** A person as their avatar and login; with a `profileUrl` it links to GitHub's page for them. */
export function PullRequestActorLabel({
  actor,
  profileUrl,
  variant = 'label',
}: {
  actor: Actor | null;
  profileUrl?: string | null;
  variant?: 'label' | 'avatar';
}) {
  const t = usePluginTranslation('pull-requests');
  const login = actor?.login ?? t('ghost');
  const name =
    actor?.name && actor.name !== login ? t('actor.tooltip', { name: actor.name, login }) : login;
  const content = (
    <>
      <PullRequestActorAvatar actor={actor} />
      <span className={variant === 'label' ? 'mrpr-truncate mrpr-actor-login' : 'mrpr-sr-only'}>
        {login}
      </span>
    </>
  );
  return profileUrl ? (
    <a
      className="mrpr-actor mrpr-actor-link"
      href={profileUrl}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={t('actor.profile', { login })}
      title={t('actor.tooltipProfile', { tooltip: name })}
    >
      {content}
    </a>
  ) : (
    <span className="mrpr-actor" title={name}>
      {content}
    </span>
  );
}
