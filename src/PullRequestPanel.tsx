// Ported from T3 Code (https://github.com/pingdotgg/t3code, apps/web/src/components/pullRequest/PullRequestDetailLayout.tsx and PullRequestDetailCrumbs.tsx at 8ab427c6), MIT, Copyright (c) 2026 T3 Tools Inc. See NOTICE.
// The side panel: the header of the pull request a link opened, then its Summary and its Code.
import { useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { ArrowLeft, FileDiff } from 'lucide-react';
import { usePluginTranslation } from '@mindroom/client-sdk/core';
import { useMarkdownHtml } from '@mindroom/client-sdk/ui';
import { CodeTab } from './CodeTab';
import { parsePullRequestUrl, pullRequestUrl, type PullRequestRef } from './github';
import { GitHubErrorState } from './GitHubErrorState';
import {
  PullRequestActorAvatar,
  PullRequestDiffStat,
  PullRequestMetaLine,
  RelativeTime,
  resolvePullRequestState,
} from './presentation';
import { usePullRequest, usePullRequestFiles } from './queries';
import { pluginRootStyle } from './theme';
import { useGitHubToken } from './token';

const TABS = ['summary', 'code'] as const;
type Tab = (typeof TABS)[number];

/** The pull request a side panel request names, or undefined for anything that is not one. */
function readRequest(request: unknown): PullRequestRef | undefined {
  if (typeof request !== 'object' || request === null) return undefined;
  const { owner, repo, number } = request as Record<string, unknown>;
  if (typeof owner !== 'string' || typeof repo !== 'string' || typeof number !== 'number') {
    return undefined;
  }
  try {
    const parsed = parsePullRequestUrl(new URL(pullRequestUrl({ owner, repo, number })));
    // The URL parser resolves dot segments, so "../x" would name another repository; the request
    // counts only when it comes out as it went in.
    return parsed?.owner === owner && parsed.repo === repo && parsed.number === number
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
}

function TabBar({ value, onChange }: { value: Tab; onChange: (tab: Tab) => void }) {
  const t = usePluginTranslation('pull-requests');
  const barRef = useRef<HTMLDivElement>(null);
  const onKeyDown = (event: KeyboardEvent) => {
    const rtl = barRef.current ? getComputedStyle(barRef.current).direction === 'rtl' : false;
    const forward = rtl ? 'ArrowLeft' : 'ArrowRight';
    const backward = rtl ? 'ArrowRight' : 'ArrowLeft';
    if (event.key !== forward && event.key !== backward) return;
    event.preventDefault();
    const step = event.key === forward ? 1 : -1;
    const next = TABS[(TABS.indexOf(value) + step + TABS.length) % TABS.length] ?? value;
    onChange(next);
    barRef.current?.querySelector<HTMLElement>(`#mrpr-tab-${next}`)?.focus();
  };
  return (
    <nav className="mrpr-tabbar" aria-label={t('panelLabel')}>
      <div ref={barRef} className="mrpr-tabs" role="tablist" onKeyDown={onKeyDown}>
        {TABS.map((tab) => (
          <button
            key={tab}
            id={`mrpr-tab-${tab}`}
            className="mrpr-tab"
            type="button"
            role="tab"
            aria-selected={tab === value}
            aria-controls={`mrpr-tabpanel-${tab}`}
            tabIndex={tab === value ? 0 : -1}
            onClick={() => onChange(tab)}
          >
            {t(`tab.${tab}`)}
          </button>
        ))}
      </div>
    </nav>
  );
}

function Description({ body }: { body: string }) {
  const t = usePluginTranslation('pull-requests');
  const html = useMarkdownHtml(body);
  if (body.trim() === '') return <p className="mrpr-status">{t('noDescription')}</p>;
  if (html === undefined) return null;
  return <div className="mrpr-description" dangerouslySetInnerHTML={{ __html: html }} />;
}

function Files({ pullRequest }: { pullRequest: PullRequestRef }) {
  const t = usePluginTranslation('pull-requests');
  const query = usePullRequestFiles(pullRequest, true);
  if (query.data) return <CodeTab pullRequest={pullRequest} files={query.data} />;
  return (
    <div className="mrpr-panel-note">
      {query.isError ? (
        <GitHubErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : (
        <p className="mrpr-status">{t('loadingFiles')}</p>
      )}
    </div>
  );
}

export default function PullRequestPanel({ request }: { roomId: string; request?: unknown }) {
  const t = usePluginTranslation('pull-requests');
  const ref = useMemo(() => readRequest(request), [request]);
  const query = usePullRequest(ref);
  const { token, forget } = useGitHubToken();
  const [tab, setTab] = useState<Tab>('summary');
  const pr = query.data;
  const state = pr && resolvePullRequestState(pr);

  return (
    <div className="mrpr-root mrpr-panel" style={pluginRootStyle()}>
      {!ref ? (
        <p className="mrpr-status mrpr-panel-note">{t('emptyPanel')}</p>
      ) : !pr || !state ? (
        <div className="mrpr-panel-note">
          {query.isError ? (
            <GitHubErrorState error={query.error} onRetry={() => void query.refetch()} />
          ) : (
            <p className="mrpr-status">{t('loading')}</p>
          )}
        </div>
      ) : (
        <>
          <div className="mrpr-header">
            <div className="mrpr-crumbs">
              <span className="mrpr-truncate">
                {ref.owner}/{ref.repo}
              </span>
              <span className="mrpr-shrink-0">#{ref.number}</span>
              <span aria-hidden>·</span>
              <span className="mrpr-state">
                <state.Icon aria-hidden className={`mrpr-icon ${state.toneClassName}`} />
                {t(`state.${state.key}`)}
              </span>
            </div>
            <p className="mrpr-panel-title">{pr.title}</p>
            <div className="mrpr-panel-meta">
              <PullRequestMetaLine>
                <PullRequestActorAvatar key="avatar" actor={pr.author} />
                <span key="name" className="mrpr-truncate">
                  {pr.author?.login ?? t('ghost')}
                </span>
                <span key="updated" className="mrpr-shrink-0">
                  <RelativeTime timestamp={pr.updatedAt} label={(time) => t('updated', { time })} />
                </span>
              </PullRequestMetaLine>
            </div>
            <div className="mrpr-branches">
              <span className="mrpr-refs">
                <span className="mrpr-truncate">{pr.baseRef}</span>
                <ArrowLeft aria-label={t('receivesChanges')} className="mrpr-arrow" />
                <span className="mrpr-truncate">{pr.headRef}</span>
              </span>
              <span className="mrpr-counts">
                <span className="mrpr-file-count">
                  <FileDiff aria-hidden className="mrpr-arrow mrpr-file-icon" />
                  {t('code.fileCount', { count: pr.changedFiles })}
                </span>
                <PullRequestDiffStat additions={pr.additions} deletions={pr.deletions} />
              </span>
            </div>
            <div className="mrpr-header-actions">
              <a className="mrpr-link" href={pr.url} target="_blank" rel="noopener noreferrer">
                {t('openOnGitHub')}
              </a>
              {token !== undefined ? (
                <button className="mrpr-button" type="button" onClick={forget}>
                  {t('token.forget')}
                </button>
              ) : null}
            </div>
          </div>
          <TabBar value={tab} onChange={setTab} />
          <div
            className={tab === 'code' ? 'mrpr-tabpanel mrpr-tabpanel-code' : 'mrpr-tabpanel'}
            role="tabpanel"
            id={`mrpr-tabpanel-${tab}`}
            aria-labelledby={`mrpr-tab-${tab}`}
          >
            {tab === 'summary' ? <Description body={pr.body} /> : <Files pullRequest={ref} />}
          </div>
        </>
      )}
    </div>
  );
}
