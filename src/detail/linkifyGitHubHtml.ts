// Post-processes sanitized GitHub Markdown HTML to link verified issues, PRs, mentions,
// commits, and bare video attachment URLs outside links and code elements.
import type { GitHubBodyMeta } from '../githubBody';
import { ATTACHMENT_PATH, httpsUrl, own } from '../images';

const escapeHtml = (v: string) =>
  v.replace(/[&"'<>]/gu, (c) =>
    c === '&' ? '&amp;' : c === '"' ? '&quot;' : c === "'" ? '&#39;' : c === '<' ? '&lt;' : '&gt;'
  );

// Regex for eligible HTML text segments (outside `<a>`, `<code>`, `<pre>`).
// Lookbehinds include `-` and `&` so repeated hyphenated runs do not backtrack quadratically and
// HTML numeric entities like `&#42;` are never matched.
const HTML_LINKIFY_TOKEN =
  /(?<![\w])(https?:\/\/[^\s<>"']+)|(?<![\w/&.-])((?:[A-Za-z0-9-]+\/[A-Za-z0-9._-]+)?#[1-9]\d*|[Gg][Hh]-[1-9]\d*)\b|(?<![\w/@.-])(@[A-Za-z0-9-]+(?:\/[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*)?)(?![\w-]|[.:][\w[])|(?<![\w/@.-])(?:([A-Za-z0-9-]+\/[A-Za-z0-9._-]+)@)?([0-9a-f]{7,40})(?![\w-]|[.:][\w[])/gu;
const TAG_NAME = /^<\/?([A-Za-z][A-Za-z0-9-]*)(?=[\s/>])/u;
const TAG_START_CHAR = /[A-Za-z/!?]/u;
const URL_TRAILING_PUNCT = /[.,;:!?)\]]+$/u;
const anchor = (href: string, innerHtml: string) =>
  `<a href="${escapeHtml(href)}" target="_blank" rel="noreferrer noopener">${innerHtml}</a>`;

function linkifyTextSegment(
  segment: string,
  meta: GitHubBodyMeta,
  bareCommits: [string, string][],
  repoCommits: [string, string][]
): string {
  HTML_LINKIFY_TOKEN.lastIndex = 0;
  return segment.replace(HTML_LINKIFY_TOKEN, (match, ...args) => {
    const [urlTok, issueTok, mentionTok, repo, sha] = args as (string | undefined)[];
    if (urlTok) {
      const trail = URL_TRAILING_PUNCT.exec(urlTok)?.[0] ?? '';
      const parsed = httpsUrl(trail ? urlTok.slice(0, -trail.length) : urlTok);
      const uuid =
        parsed?.hostname === 'github.com' && !parsed.search && !parsed.hash
          ? ATTACHMENT_PATH.exec(parsed.pathname)?.[1]?.toLowerCase()
          : undefined;
      const video = uuid ? own(meta.videos, uuid) : undefined;
      return video ? `${anchor(parsed!.href, escapeHtml(video.label))}${trail}` : urlTok;
    }
    if (issueTok || mentionTok) {
      const href = own(meta.links, match.toLowerCase());
      const safe = href && httpsUrl(href);
      return safe ? anchor(safe.href, escapeHtml(match)) : match;
    }
    if (!sha) return match;
    const pool = repo ? repoCommits : bareCommits;
    const prefix = repo ? `${repo.toLowerCase()}@${sha}` : sha;
    let matchedHref: string | undefined;
    for (const [key, href] of pool) {
      if (!key.startsWith(prefix)) continue;
      if (matchedHref && matchedHref !== href) return match;
      matchedHref = href;
    }
    const safe = matchedHref && httpsUrl(matchedHref);
    return safe
      ? anchor(
          safe.href,
          `<code>${escapeHtml(`${repo ? `${repo}@` : ''}${sha.slice(0, 7)}`)}</code>`
        )
      : match;
  });
}

/**
 * Links verified GitHub issues, PRs, mentions, commits, and bare video attachment URLs
 * in sanitized HTML outside `<a>`, `<code>`, and `<pre>` elements.
 */
export function linkifyGitHubHtml(html: string, bodyMeta?: GitHubBodyMeta): string {
  if (!bodyMeta || !Object.values(bodyMeta).some((m) => Object.keys(m).length > 0)) return html;

  const bareCommits: [string, string][] = [];
  const repoCommits: [string, string][] = [];
  for (const [key, href] of Object.entries(bodyMeta.commits)) {
    (key.includes('@') ? repoCommits : bareCommits).push([key, href]);
  }

  const parts: string[] = [];
  const depth = { a: 0, code: 0, pre: 0 };
  let i = 0;
  const pushText = (text: string) => {
    if (!text) return;
    parts.push(
      depth.a || depth.code || depth.pre
        ? text
        : linkifyTextSegment(text, bodyMeta, bareCommits, repoCommits)
    );
  };

  while (i < html.length) {
    const lt = html.indexOf('<', i);
    pushText(html.slice(i, lt === -1 ? html.length : lt));
    if (lt === -1) break;

    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      parts.push(html.slice(lt, end === -1 ? html.length : end + 3));
      if (end === -1) break;
      i = end + 3;
      continue;
    }

    const next = html[lt + 1];
    if (!next || !TAG_START_CHAR.test(next)) {
      parts.push('<');
      i = lt + 1;
      continue;
    }

    let p = lt + 1;
    while (p < html.length && html[p] !== '>') {
      if (html[p] === '"' || html[p] === "'") {
        const q = html.indexOf(html[p]!, p + 1);
        p = q === -1 ? html.length : q + 1;
      } else {
        p += 1;
      }
    }
    const tag = html.slice(lt, p + 1);
    parts.push(tag);
    if (p >= html.length) break;

    const delta = next === '/' ? -1 : tag.endsWith('/>') ? 0 : 1;
    const name = delta ? TAG_NAME.exec(tag)?.[1]?.toLowerCase() : undefined;
    if (name === 'a' || name === 'code' || name === 'pre') {
      depth[name] = Math.max(0, depth[name] + delta);
    }
    i = p + 1;
  }

  return parts.join('');
}
