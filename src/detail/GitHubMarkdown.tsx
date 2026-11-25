// Shared GitHub Markdown renderer for descriptions and comments: strips HTML comments, links
// verified refs/videos, resolves images via GitHub's HTML, and shows plain text while loading.
import { useMemo, type ReactNode } from 'react';
import { MarkdownContent, useMarkdownHtml } from '@mindroom/client-sdk/ui';
import type { GitHubBodyMeta } from '../githubBody';
import { imageResolver, type ImageSources } from '../images';
import { linkifyGitHubHtml, stripGitHubHtmlComments } from './prepareGitHubMarkdown';
import { useSignedImageFallback } from './imageFallback';

export type GitHubMarkdownProps = {
  body: string;
  images: ImageSources;
  bodyMeta?: GitHubBodyMeta;
  className?: string;
  empty?: ReactNode;
};

export function useGitHubMarkdown(body: string, images: ImageSources, bodyMeta?: GitHubBodyMeta) {
  const prepared = useMemo(() => stripGitHubHtmlComments(body), [body]);
  // One function per answer of GitHub's: a new one would sanitize the body again on each render.
  const imageSource = useMemo(() => imageResolver(images), [images]);
  const rawHtml = useMarkdownHtml(prepared ?? '', { imageSource });
  const html = useMemo(
    () => (rawHtml === undefined ? undefined : linkifyGitHubHtml(rawHtml, bodyMeta)),
    [rawHtml, bodyMeta]
  );
  const imagesRef = useSignedImageFallback(images);
  return { prepared, html, imagesRef };
}

export function GitHubMarkdownView({
  prepared,
  html,
  imagesRef,
  className = 'mrpr-markdown',
}: ReturnType<typeof useGitHubMarkdown> & { prepared: string; className?: string }) {
  if (html === undefined) {
    const cls = className === 'mrpr-markdown' ? className : `${className} mrpr-markdown`;
    return <div className={`${cls} mrpr-comment-plain`}>{prepared}</div>;
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
  if (state.prepared === null) return empty;
  return <GitHubMarkdownView {...state} prepared={state.prepared} className={className} />;
}
