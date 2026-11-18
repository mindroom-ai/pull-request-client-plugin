// Ported from T3 Code (https://github.com/pingdotgg/t3code, apps/web/src/components/pullRequest/PullRequestCommentBody.tsx at 8ab427c6), MIT, Copyright (c) 2026 T3 Tools Inc. See NOTICE.
// A comment's Markdown, drawn by the app's renderer as a thread draws it (a wide table scrolls in
// its own box), clamped at 15rem with a button that shows it whole. A body of only HTML comments
// (a bot's markers) draws nothing. Its images load only from GitHub: an attachment from its stable
// address (signed when that fails), another image via camo.
import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { usePluginTranslation } from '@mindroom/client-sdk/core';
import { MarkdownContent, useMarkdownHtml } from '@mindroom/client-sdk/ui';
import { imageResolver, type ImageSources } from '../images';
import { useRootFontSize } from '../rootFontSize';
import { visibleBody } from './detail.logic';
import { useSignedImageFallback } from './imageFallback';

/** The clamp's height in rem, as styles.css has it. */
const CLAMP_REM = 15;

export function CommentBody({ body, images }: { body: string; images: ImageSources }) {
  const t = usePluginTranslation('pull-requests');
  const visible = visibleBody(body);
  // One function per answer of GitHub's: a new one would sanitize the body again on each render.
  const imageSource = useMemo(() => imageResolver(images), [images]);
  // The plain text shows until the app's Markdown renderer has loaded.
  const html = useMarkdownHtml(visible ?? '', { imageSource });
  const imagesRef = useSignedImageFallback(images);
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
  }, [clamp, html, visible]);

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
          // The app's renderer sanitizes this HTML under its own policy and draws it as a thread's.
          <MarkdownContent ref={imagesRef} className="mrpr-markdown" html={html} />
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
