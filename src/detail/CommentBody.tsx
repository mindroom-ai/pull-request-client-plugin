// Ported from T3 Code (https://github.com/pingdotgg/t3code, apps/web/src/components/pullRequest/PullRequestCommentBody.tsx at 8ab427c6), MIT, Copyright (c) 2026 T3 Tools Inc. See NOTICE.
// A comment's Markdown, drawn by the app's renderer, clamped at 240 px with a button that shows it
// whole. A body of only HTML comments (a bot's markers) draws nothing.
import { useId, useLayoutEffect, useRef, useState } from 'react';
import { usePluginTranslation } from '@mindroom/client-sdk/core';
import { useMarkdownHtml } from '@mindroom/client-sdk/ui';
import { visibleBody } from './detail.logic';

const CLAMP = 240;

export function CommentBody({ body }: { body: string }) {
  const t = usePluginTranslation('pull-requests');
  const visible = visibleBody(body);
  // The plain text shows until the app's Markdown renderer has loaded.
  const html = useMarkdownHtml(visible ?? '');
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const clip = useRef<HTMLDivElement>(null);
  const id = useId();

  useLayoutEffect(() => {
    const element = clip.current;
    if (!element) return;
    const measure = () => setOverflowing(element.scrollHeight > CLAMP);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    for (const child of Array.from(element.children)) observer.observe(child);
    return () => observer.disconnect();
  }, [html, visible]);

  if (visible === null) return null;
  return (
    <div className="mrpr-comment-body">
      <div
        ref={clip}
        id={id}
        className={`mrpr-comment-clip${expanded ? '' : ' mrpr-comment-clamped'}`}
        onFocusCapture={() => setExpanded(true)}
      >
        {html === undefined ? (
          <div className="mrpr-markdown mrpr-comment-plain">{visible}</div>
        ) : (
          // The app's renderer sanitizes this HTML under its own policy.
          <div className="mrpr-markdown" dangerouslySetInnerHTML={{ __html: html }} />
        )}
        {overflowing && !expanded ? <div aria-hidden className="mrpr-comment-fade" /> : null}
      </div>
      {overflowing ? (
        <button
          type="button"
          className="mrpr-button mrpr-button-quiet"
          aria-expanded={expanded}
          aria-controls={id}
          onClick={() => {
            if (expanded) clip.current?.scrollIntoView({ block: 'nearest' });
            setExpanded(!expanded);
          }}
        >
          {expanded ? t('comment.showLess') : t('comment.showFull')}
        </button>
      ) : null}
    </div>
  );
}
