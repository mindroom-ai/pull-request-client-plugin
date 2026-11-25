// Ported from T3 Code (https://github.com/pingdotgg/t3code, apps/web/src/components/pullRequest/PullRequestCommentBody.tsx at 8ab427c6), MIT, Copyright (c) 2026 T3 Tools Inc. See NOTICE.
// A comment's Markdown, drawn by the app's renderer as a thread draws it (a wide table scrolls in
// its own box), clamped at 15rem with a button that shows it whole. A body of only HTML comments
// (a bot's markers) draws nothing. Its images load only from GitHub: an attachment from its stable
// address (signed when that fails), another image via camo.
import { useId, useLayoutEffect, useRef, useState } from 'react';
import { usePluginTranslation } from '@mindroom/client-sdk/core';
import { useRootFontSize } from '../rootFontSize';
import { GitHubMarkdownView, useGitHubMarkdown, type GitHubMarkdownProps } from './GitHubMarkdown';

/** The clamp's height in rem, as styles.css has it. */
const CLAMP_REM = 15;

export function CommentBody({
  body,
  images,
  bodyMeta,
}: Pick<GitHubMarkdownProps, 'body' | 'images' | 'bodyMeta'>) {
  const t = usePluginTranslation('pull-requests');
  const { prepared, html, imagesRef } = useGitHubMarkdown(body, images, bodyMeta);
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const clip = useRef<HTMLDivElement>(null);
  const id = useId();
  const clamp = CLAMP_REM * useRootFontSize();

  useLayoutEffect(() => {
    const element = clip.current;
    if (!element) return;
    const measure = () => setOverflowing(element.scrollHeight > clamp);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    for (const child of Array.from(element.children)) observer.observe(child);
    return () => observer.disconnect();
  }, [clamp, html, prepared]);

  if (prepared === null) return null;
  return (
    <div className="mrpr-comment-body">
      <div
        ref={clip}
        id={id}
        className={`mrpr-comment-clip${expanded ? '' : ' mrpr-comment-clamped'}`}
        onFocusCapture={() => setExpanded(true)}
      >
        <GitHubMarkdownView prepared={prepared} html={html} imagesRef={imagesRef} />
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
