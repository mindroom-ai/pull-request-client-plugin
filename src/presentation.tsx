// Ported from T3 Code (https://github.com/pingdotgg/t3code, apps/web/src/components/pullRequest/pullRequestIcons.tsx and pullRequestPresentation.tsx at 8ab427c6), MIT, Copyright (c) 2026 T3 Tools Inc. See NOTICE.
// How a pull request's state, author, diff counts and age look, shared by the card and the panel.
import { Children, isValidElement, useState, type ReactNode } from 'react';
import {
  GitMerge,
  GitPullRequestArrow,
  GitPullRequestClosed,
  GitPullRequestDraft,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { PullRequest } from './github';

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
