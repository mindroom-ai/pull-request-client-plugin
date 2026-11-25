// Shared GitHub Markdown renderer for descriptions and comments: strips HTML comments via the
// client SDK, links verified refs/videos, resolves images via GitHub's HTML, and shows plain
// text while loading.
import { useMemo, type ReactNode } from 'react';
import { MarkdownContent, useMarkdownHtml } from '@mindroom/client-sdk/ui';
import type { GitHubBodyMeta } from '../githubBody';
import { imageResolver, type ImageSources } from '../images';
import { visibleBody } from './detail.logic';
import { useSignedImageFallback } from './imageFallback';
import { linkifyGitHubHtml } from './linkifyGitHubHtml';

export type GitHubMarkdownProps = {
  body: string;
  images: ImageSources;
  bodyMeta?: GitHubBodyMeta;
  className?: string;
  empty?: ReactNode;
};

export function useGitHubMarkdown(body: string, images: ImageSources, bodyMeta?: GitHubBodyMeta) {
  const visible = useMemo(() => visibleBody(body), [body]);
  // One function per answer of GitHub's: a new one would sanitize the body again on each render.
  const imageSource = useMemo(() => imageResolver(images), [images]);
  const rawHtml = useMarkdownHtml(body, { imageSource, commonMarkHtml: true });
  const html = useMemo(
    () => (rawHtml === undefined ? undefined : linkifyGitHubHtml(rawHtml, bodyMeta)),
    [rawHtml, bodyMeta]
  );
  const imagesRef = useSignedImageFallback(images);
  const isEmpty = html === undefined ? visible === null : html.trim() === '';
  return { visible: isEmpty ? null : body, html, imagesRef };
}

export function GitHubMarkdownView({
  visible,
  html,
  imagesRef,
  className = 'mrpr-markdown',
}: ReturnType<typeof useGitHubMarkdown> & { visible: string; className?: string }) {
  if (html === undefined) {
    const cls = className === 'mrpr-markdown' ? className : `${className} mrpr-markdown`;
    return <div className={`${cls} mrpr-comment-plain`}>{visible}</div>;
  }
  // The app's renderer sanitizes this HTML under its own policy and draws it as a thread's.
  return <MarkdownContent ref={imagesRef} className={className} html={html} />;
}

export function GitHubMarkdown({
  body,
  images,
  bodyMeta,
  className,
  empty = null,
}: GitHubMarkdownProps) {
  const state = useGitHubMarkdown(body, images, bodyMeta);
  if (state.visible === null) return empty;
  return <GitHubMarkdownView {...state} visible={state.visible} className={className} />;
}
