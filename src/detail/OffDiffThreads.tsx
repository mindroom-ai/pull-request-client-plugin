// Ported from T3 Code (https://github.com/pingdotgg/t3code, apps/web/src/components/pullRequest/PullRequestCodeTab.tsx at 8ab427c6), MIT, Copyright (c) 2026 T3 Tools Inc. See NOTICE.
// The bar above the diffs that holds the review threads no rendered line holds, closed until
// chosen: the threads grouped by file, each with its line when it has one.
import { useId, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { usePluginTranslation } from '@mindroom/client-sdk/core';
import type { ReviewThread } from '../reviewThreads';
import { ReviewThreadCard } from './ReviewThreadCard';

export function OffDiffThreads({ threads }: { threads: ReviewThread[] }) {
  const t = usePluginTranslation('pull-requests');
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  if (threads.length === 0) return null;
  const byPath = new Map<string, ReviewThread[]>();
  for (const thread of threads) {
    byPath.set(thread.path, [...(byPath.get(thread.path) ?? []), thread]);
  }
  return (
    <div className="mrpr-off-diff">
      <button
        type="button"
        className="mrpr-off-diff-toggle"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen(!open)}
      >
        <span>{t('code.offDiff', { count: threads.length })}</span>
        <ChevronRight
          aria-hidden
          className={`mrpr-icon mrpr-chevron${open ? ' mrpr-chevron-open' : ''}`}
        />
      </button>
      {open ? (
        <div id={bodyId} className="mrpr-off-diff-body">
          {[...byPath].map(([path, fileThreads]) => (
            <div key={path} role="group" aria-label={path} className="mrpr-off-diff-file">
              <p className="mrpr-off-diff-path mrpr-truncate" title={path}>
                {path}
              </p>
              {fileThreads.map((thread) => (
                <div key={thread.id}>
                  {thread.line === null ? null : (
                    <p className="mrpr-off-diff-line">{t('code.line', { line: thread.line })}</p>
                  )}
                  <ReviewThreadCard thread={thread} />
                </div>
              ))}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
