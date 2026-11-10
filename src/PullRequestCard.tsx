// Ported from T3 Code (https://github.com/pingdotgg/t3code, apps/web/src/components/pullRequest/PullRequestLinkPreview.tsx at 8ab427c6), MIT, Copyright (c) 2026 T3 Tools Inc. See NOTICE.
// The card a pull request link in a message opens: the app draws its glass menu around this, and
// the card draws the pull request's summary and its actions as menu rows.
import { useMemo, useState } from 'react';
import { Icons } from 'folds';
import {
  useRoomSidePanel,
  usePluginTranslation,
  type MessageLinkCardProps,
} from '@mindroom/client-sdk/core';
import { MenuEntry, MenuGroup } from '@mindroom/client-sdk/ui';
import { parsePullRequestUrl } from './github';
import { GitHubErrorState } from './GitHubErrorState';
import {
  PullRequestActorAvatar,
  PullRequestMetaLine,
  RelativeTime,
  resolvePullRequestState,
} from './presentation';
import { usePullRequest } from './queries';
import { pluginRootStyle } from './theme';

const parse = (href: string) => {
  try {
    return parsePullRequestUrl(new URL(href));
  } catch {
    return undefined;
  }
};

export function PullRequestCard({ href, close }: MessageLinkCardProps) {
  const t = usePluginTranslation('pull-requests');
  const ref = useMemo(() => parse(href), [href]);
  const query = usePullRequest(ref);
  const panel = useRoomSidePanel('pull-requests', 'pull-request');
  const [copied, setCopied] = useState(false);
  if (!ref) return null;
  const pr = query.data;
  const state = pr && resolvePullRequestState(pr);

  const copy = async () => {
    // A page without a clipboard (an insecure context) leaves the row as it was.
    if (!navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(href);
      setCopied(true);
    } catch {
      // The browser refused the clipboard; the row stays as it was.
    }
  };

  return (
    <div className="mrpr-root" style={pluginRootStyle()}>
      <div className="mrpr-card">
        <div className="mrpr-meta">
          <span className="mrpr-truncate">
            {ref.owner}/{ref.repo}
          </span>
          <span className="mrpr-shrink-0">#{ref.number}</span>
          {state ? (
            <>
              <span aria-hidden>·</span>
              <span className="mrpr-state">
                <state.Icon aria-hidden className={`mrpr-icon ${state.toneClassName}`} />
                {t(`state.${state.key}`)}
              </span>
            </>
          ) : null}
        </div>
        {pr ? (
          <>
            <p className="mrpr-title">{pr.title}</p>
            <div className="mrpr-author">
              <PullRequestMetaLine>
                <span key="author" className="mrpr-author-name">
                  <PullRequestActorAvatar actor={pr.author} />
                  <span className="mrpr-truncate">{pr.author?.login ?? t('ghost')}</span>
                </span>
                <span key="opened" className="mrpr-shrink-0">
                  <RelativeTime timestamp={pr.createdAt} label={(time) => t('opened', { time })} />
                </span>
              </PullRequestMetaLine>
            </div>
          </>
        ) : query.isError ? (
          <GitHubErrorState error={query.error} onRetry={() => void query.refetch()} />
        ) : (
          <p className="mrpr-status">{t('loading')}</p>
        )}
      </div>
      <MenuGroup>
        {panel ? (
          <MenuEntry
            label={t('openInSidePanel')}
            icon={Icons.Code}
            onSelect={() => {
              panel.open(ref);
              close();
            }}
          />
        ) : null}
        <MenuEntry
          label={t('openOnGitHub')}
          icon={Icons.External}
          onSelect={() => {
            window.open(href, '_blank', 'noopener,noreferrer');
            close();
          }}
        />
        <MenuEntry
          label={copied ? t('copied') : t('copyLink')}
          icon={copied ? Icons.Check : Icons.Link}
          onSelect={() => void copy()}
        />
      </MenuGroup>
    </div>
  );
}
