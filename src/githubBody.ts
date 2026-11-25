// Verified metadata mined from GitHub's `body_html`: autolinks GitHub resolved (issues, PRs,
// discussions, mentions, commits) and video attachments with their filename labels. DOM-free.
import { attributes, decodeEntities, httpsUrl, lastUuid, onGitHub } from './images';

export type GitHubBodyMeta = {
  links: Record<string, string>;
  commits: Record<string, string>;
  videos: Record<string, { label: string }>;
};

const ANCHOR = /<a\b((?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/a>/giu;
const VIDEO_DETAILS =
  /<details\b(?:[^>"']|"[^"]*"|'[^']*')*>(?:(?!<\/?(?:details|summary)\b)[\s\S])*?<summary\b(?:[^>"']|"[^"]*"|'[^']*')*>((?:(?!<\/?(?:details|summary)\b)[\s\S])*?)<\/summary>(?:(?!<\/?details\b)[\s\S])*?<video\b((?:[^>"']|"[^"]*"|'[^']*')*)>/giu;
const TAG = /<(?:[^>"']|"[^"]*"|'[^']*')*>/gu;
const COMMIT_PATH =
  /^\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)\/(?:commit|pull\/[1-9]\d*\/commits)\/([0-9a-f]{40})\/?$/iu;
const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);
const innerText = (html: string) =>
  decodeEntities(html.replace(TAG, '')).replace(/\s+/gu, ' ').trim();
const put = <T>(map: Record<string, T>, key: string, value: T) => {
  if (key && !FORBIDDEN.has(key)) map[key] = value;
};

/** Verified autolinks and video labels from GitHub's `body_html`; empty when absent. */
export function extractGitHubBodyMeta(html: unknown): GitHubBodyMeta {
  const meta: GitHubBodyMeta = { links: {}, commits: {}, videos: {} };
  if (typeof html !== 'string') return meta;
  for (const [, inside, body] of html.matchAll(ANCHOR)) {
    const attrs = attributes(inside!);
    const href = httpsUrl(attrs.get('href') ?? '');
    if (!href || href.hostname !== 'github.com') continue;
    const cls = new Set((attrs.get('class') ?? '').split(/\s+/u));
    if (cls.has('commit-link')) {
      const m = COMMIT_PATH.exec(href.pathname);
      if (m) {
        const sha = m[3]!.toLowerCase();
        put(meta.commits, sha, href.href);
        put(meta.commits, `${m[1]}/${m[2]}@${sha}`.toLowerCase(), href.href);
      }
    } else if (cls.has('issue-link') || cls.has('user-mention') || cls.has('team-mention')) {
      put(meta.links, innerText(body!).toLowerCase(), href.href);
    }
  }
  for (const [, summary, videoInside] of html.matchAll(VIDEO_DETAILS)) {
    const attrs = attributes(videoInside!);
    const rawSrc = attrs.get('src');
    const srcUrl = rawSrc ? httpsUrl(rawSrc) : null;
    if (rawSrc && (!srcUrl || !onGitHub(srcUrl))) continue;
    const canonical = httpsUrl(attrs.get('data-canonical-src') ?? '');
    const uuid =
      (srcUrl && lastUuid(srcUrl.pathname)) ||
      (canonical && onGitHub(canonical) ? lastUuid(canonical.pathname) : undefined);
    if (uuid) put(meta.videos, uuid, { label: innerText(summary!) || 'video' });
  }
  return meta;
}
