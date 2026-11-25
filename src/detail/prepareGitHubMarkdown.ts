// Two strictly O(N) stages for GitHub Markdown descriptions and comments:
// Stage A (`stripGitHubHtmlComments`) removes HTML comments outside code before `useMarkdownHtml`.
// Stage B (`linkifyGitHubHtml`) links verified GitHub refs/commits/videos in sanitized HTML.
import type { GitHubBodyMeta } from '../githubBody';
import { ATTACHMENT_PATH, httpsUrl, own } from '../images';

const ASCII_PUNCT = /[!"#$%&'()*+,-./:;<=>?@[\\\]^_`{|}~]/u;
const BQ_PREFIX = /^(?: {0,3}> ?)+/u;
const INDENTED_CODE = /^(?: {4}| {0,3}\t)/u;
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/u;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/u;
const ATX_HEADING = /^ {0,3}#{1,6}(?:[ \t]|$)/u;
const PARA_BREAK = /^(?:[ \t]*$| {0,3}(?:<!--|#{1,6}(?:[ \t]|$)|`{3,}[^`]*$|~{3,}))/u;
const escapeHtml = (v: string) =>
  v.replace(/[&"'<>]/gu, (c) =>
    c === '&' ? '&amp;' : c === '"' ? '&quot;' : c === "'" ? '&#39;' : c === '<' ? '&lt;' : '&gt;'
  );
const stripBq = (line: string) => line.slice(BQ_PREFIX.exec(line)?.[0].length ?? 0);
const parseFence = (rest: string) => {
  const m = FENCE_OPEN.exec(rest);
  return m && (m[1]![0] === '~' || !m[2]!.includes('`'))
    ? { char: m[1]![0]!, len: m[1]!.length }
    : null;
};

/** Stage A: strips HTML comments outside code blocks/spans in O(N) time, or returns `null`. */
export function stripGitHubHtmlComments(body: string): string | null {
  const s = body.includes('\r') ? body.replace(/\r\n?/gu, '\n') : body;
  if (!s.includes('<!--')) return s.trim() ? s : null;

  const out: string[] = [];
  const gap: string[] = [];
  const noCloseLen = new Set<number>();
  let fence: { char: string; len: number } | null = null;
  let afterBlankOrCode = true;
  let noMoreCommentClose = false;
  let gapHasComment = false;
  let paraLimit = -1;

  const endOfLine = (from: number) => ((from = s.indexOf('\n', from)) === -1 ? s.length : from);
  // Line kinds: 0 = visible/protected, 1 = natural blank, 2 = comment-only.
  const emit = (text: string, kind: 0 | 1 | 2) => {
    if (kind) {
      gap.push(text);
      gapHasComment ||= kind === 2;
    } else {
      if (gap.length) out.push(...(gapHasComment ? (out.length ? [''] : []) : gap));
      gap.length = 0;
      gapHasComment = false;
      out.push(text);
    }
  };
  const findSpanEnd = (start: number, len: number, lineEnd: number, isHeading: boolean) => {
    if (!isHeading && lineEnd > paraLimit) {
      noCloseLen.clear();
      for (paraLimit = lineEnd; paraLimit < s.length;) {
        const next = endOfLine(paraLimit + 1);
        if (PARA_BREAK.test(stripBq(s.slice(paraLimit + 1, next)))) break;
        paraLimit = next;
      }
    }
    const limit = isHeading ? lineEnd : paraLimit;
    if (noCloseLen.has(len)) return -1;
    for (let q = start; (q = s.indexOf('`', q)) !== -1 && q < limit;) {
      let m = 0;
      while (s[q + m] === '`') m += 1;
      if (m === len) return q + m;
      q += m;
    }
    if (!isHeading) noCloseLen.add(len);
    return -1;
  };

  for (let i = 0; ;) {
    let curEnd = endOfLine(i);
    const line = s.slice(i, curEnd);
    const rest = stripBq(line);

    if (fence) {
      emit(line, 0);
      const close = FENCE_CLOSE.exec(rest);
      if (close && close[1]![0] === fence.char && close[1]!.length >= fence.len) {
        fence = null;
        afterBlankOrCode = true;
      }
    } else if (!rest.trim()) {
      emit(line, line.trim() ? 0 : 1);
      afterBlankOrCode = true;
    } else if (afterBlankOrCode && INDENTED_CODE.test(rest)) {
      emit(line, 0);
    } else if ((fence = parseFence(rest))) {
      emit(line, 0);
      afterBlankOrCode = true;
    } else {
      const isHeading = ATX_HEADING.test(rest);
      const parts: string[] = [];
      let segStart = i;
      let p = i + (line.length - rest.length);
      let hadComment = false;
      let atLineStart = true;

      while (p < curEnd) {
        const ch = s[p]!;
        if (ch === '\\' && p + 1 < curEnd && ASCII_PUNCT.test(s[p + 1]!)) {
          atLineStart = false;
          p += 2;
        } else if (ch === '`') {
          let len = 0;
          while (p + len < curEnd && s[p + len] === '`') len += 1;
          atLineStart = false;
          const spanEnd = findSpanEnd(p + len, len, curEnd, isHeading);
          if (spanEnd > curEnd) curEnd = endOfLine(spanEnd);
          p = spanEnd === -1 ? p + len : spanEnd;
        } else if (!noMoreCommentClose && ch === '<' && s.startsWith('<!--', p)) {
          const close = s.indexOf('-->', p + 4);
          if (close === -1) {
            noMoreCommentClose = true;
            atLineStart = false;
            p += 4;
          } else {
            parts.push(s.slice(segStart, p));
            hadComment = true;
            p = close + 3;
            curEnd = endOfLine(p);
            if (atLineStart) while (p < curEnd && (s[p] === ' ' || s[p] === '\t')) p += 1;
            segStart = p;
          }
        } else {
          if (ch !== ' ' && ch !== '\t') atLineStart = false;
          p += 1;
        }
      }

      parts.push(s.slice(segStart, curEnd));
      const text = parts.join('');
      const commentOnly = hadComment && !text.trim();
      emit(text, commentOnly ? 2 : text.trim() ? 0 : 1);
      afterBlankOrCode = commentOnly || isHeading;
    }

    if (curEnd >= s.length) break;
    i = curEnd + 1;
  }

  if (out.length && gap.length && !gapHasComment) out.push(...gap);
  return out.length ? out.join('\n') : null;
}

// Single linear regex for eligible HTML text segments (outside `<a>`, `<code>`, `<pre>`).
// Lookbehinds include `-` and `&` so repeated hyphenated runs never backtrack quadratically and
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
 * Stage B: links verified GitHub issues, PRs, mentions, commits, and bare video attachment URLs
 * in sanitized HTML outside `<a>`, `<code>`, and `<pre>` elements in one strictly O(N) pass.
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
