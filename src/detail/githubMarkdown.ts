// Markdown-aware preprocessor for GitHub descriptions and comments. One linear pass keeps code
// blocks, code spans, existing links/images, autolinks, and raw HTML tags untouched while stripping
// HTML comments and linking only refs/videos verified in `body_html`.
import type { GitHubBodyMeta } from '../githubBody';
import { ATTACHMENT_PATH, httpsUrl, own } from '../images';

const BLANK_LINE = /[ \t]*(?:\n|$)/uy;
const INDENTED_CODE = /(?: {4}|\t| {1,3}\t)[^\n]*(?:\n|$)/uy;
const FENCE_OPEN = /([ \t]*)([`~]{3,})([^\n]*)(?:\n|$)/uy;
const LINK_DEF = / {0,3}\[(?:\\[^\n]|[^[\]\\\n])+\]:[^\n]*(?:\n|$)/uy;
const LIST_LINE = /([ \t]*)(?:[-+*]|\d{1,9}[.)])(?:[ \t]|(?=\n|$))/uy;
const LINK_DEST =
  /\(\s*(?:<[^>\n]*>|(?:\\[^\s]|[^\s()\\]|\((?:\\[^\s]|[^\s()\\])*\))*)(?:\s+(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^()\\])*\)))?\s*\)/uy;
const REF_LABEL = /\[(?:\\[\s\S]|[^[\]\\])*\]/uy;
const ANGLE_PROTECTED =
  /<(?:[A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*|[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*|(a|code|pre)\b(?:\s(?:[^>"']|"[^"]*"|'[^']*')*)?>[\s\S]*?<\/\1\s*|\/[A-Za-z][A-Za-z0-9-]*\s*|[A-Za-z][A-Za-z0-9-]*(?:\s(?:[^>"']|"[^"]*"|'[^']*')*|\s*\/)?)>/iuy;
const TRAILING_COMMENTS = /(?:[ \t]*<!--[\s\S]*?-->)*[ \t]*(?=\n|$)/uy;
const BLANK_LINES = /(?:[ \t]*\n)+/uy;
const BLANK_BREAK = /\n[ \t]*\n/u;
const ASCII_PUNCT = /[!"#$%&'()*+,-./:;<=>?@[\\\]^_`{|}~]/u;
const REWRITE_TOKEN =
  /(https?:\/\/[^\s<>]+)|(?<![\w/])((?:[A-Za-z0-9-]+\/[A-Za-z0-9._-]+)?#[1-9]\d*|[Gg][Hh]-[1-9]\d*)\b|(?<![\w/])(@[A-Za-z0-9-]+(?:\/[A-Za-z0-9._-]+)?)\b(?!:\S)|(?<![\w/@])(?:([A-Za-z0-9-]+\/[A-Za-z0-9._-]+)@)?([0-9a-f]{7,40})\b/gu;

const execAt = (re: RegExp, s: string, pos: number) => ((re.lastIndex = pos), re.exec(s));
const indentCols = (ws: string) =>
  [...ws].reduce((cols, ch) => cols + (ch === '\t' ? 4 - (cols % 4) : 1), 0);

function matchCodeSpan(s: string, start: number): number {
  let n = 0;
  while (s[start + n] === '`') n += 1;
  for (let p = start + n; (p = s.indexOf('`', p)) !== -1;) {
    if (BLANK_BREAK.test(s.slice(start + n, p))) return -1;
    let m = 0;
    while (s[p + m] === '`') m += 1;
    if (m === n) return p + m;
    p += m;
  }
  return -1;
}

function matchMarkdownLink(s: string, start: number): number {
  let p = start + (s[start] === '!' ? 2 : 1);
  let depth = 1;
  while (p < s.length && depth > 0) {
    if (s[p] === '\\' && p + 1 < s.length) p += 2;
    else if (s[p] === '`') {
      const close = matchCodeSpan(s, p);
      if (close !== -1) p = close;
      else while (s[p] === '`') p += 1;
    } else {
      depth += s[p] === '[' ? 1 : s[p] === ']' ? -1 : 0;
      p += 1;
    }
  }
  if (depth !== 0 || BLANK_BREAK.test(s.slice(start, p))) return -1;
  const tail =
    s[p] === '(' ? execAt(LINK_DEST, s, p) : s[p] === '[' ? execAt(REF_LABEL, s, p) : null;
  return tail && !BLANK_BREAK.test(tail[0]) ? p + tail[0].length : -1;
}

function rewritePlain(segment: string, meta: GitHubBodyMeta, prevChar: string): string {
  REWRITE_TOKEN.lastIndex = 0;
  return segment.replace(REWRITE_TOKEN, (match, ...args) => {
    const [urlTok, issueTok, mentionTok, repo, sha, offset] = args as [
      string | undefined,
      string | undefined,
      string | undefined,
      string | undefined,
      string | undefined,
      number,
    ];
    if (urlTok) {
      const trail = /[.,;:!?)]+$/u.exec(urlTok)?.[0] ?? '';
      const parsed = httpsUrl(trail ? urlTok.slice(0, -trail.length) : urlTok);
      const uuid =
        parsed?.hostname === 'github.com' && !parsed.search && !parsed.hash
          ? ATTACHMENT_PATH.exec(parsed.pathname)?.[1]?.toLowerCase()
          : undefined;
      const video = uuid ? own(meta.videos, uuid) : undefined;
      return video
        ? `[${video.label.replace(/[\\[\]]/gu, '\\$&')}](${parsed!.href})${trail}`
        : urlTok;
    }
    if (offset === 0 && prevChar) {
      if (/[\w/]/u.test(prevChar) || (!issueTok && !mentionTok && !repo && prevChar === '@')) {
        return match;
      }
    }
    if (issueTok || mentionTok) {
      const href = own(meta.links, match.toLowerCase());
      return href ? `[${match}](${href})` : match;
    }
    if (!sha) return match;
    const prefix = repo ? `${repo.toLowerCase()}@${sha}` : sha;
    const hits = new Set(
      Object.entries(meta.commits)
        .filter(([k]) => (repo ? k.includes('@') : !k.includes('@')) && k.startsWith(prefix))
        .map(([, href]) => href)
    );
    return hits.size === 1
      ? `[\`${repo ? `${repo}@` : ''}${sha.slice(0, 7)}\`](${[...hits][0]})`
      : match;
  });
}

/** Strips HTML comments outside protected Markdown, links verified refs/videos, or returns `null`. */
export function prepareGitHubMarkdown(body: string, bodyMeta?: GitHubBodyMeta): string | null {
  const s = body.includes('\r') ? body.replace(/\r\n?/gu, '\n') : body;
  const hasMeta =
    bodyMeta !== undefined && Object.values(bodyMeta).some((map) => Object.keys(map).length > 0);
  let out = '';
  let i = 0;
  let plain = 0;
  let atStart = true;
  let canIndent = true;
  let inList = false;

  const flush = (end: number) => {
    if (plain < end) {
      const seg = s.slice(plain, end);
      out += hasMeta ? rewritePlain(seg, bodyMeta, out.at(-1) ?? '') : seg;
    }
  };
  const protect = (to: number) => {
    flush(i);
    out += s.slice(i, to);
    i = plain = to;
  };

  while (i < s.length) {
    if (atStart) {
      const blank = execAt(BLANK_LINE, s, i);
      if (blank) {
        protect(i + blank[0].length);
        canIndent = !inList;
        continue;
      }
      const indented = canIndent ? execAt(INDENTED_CODE, s, i) : null;
      if (indented) {
        protect(i + indented[0].length);
        inList = false;
        continue;
      }
      const fence = execAt(FENCE_OPEN, s, i);
      if (fence) {
        const cols = indentCols(fence[1]!);
        const ch = fence[2]![0]!;
        if ((cols <= 3 || inList) && !(ch === '`' && fence[3]!.includes('`'))) {
          const after = i + fence[0].length;
          const closeRe = new RegExp(
            `^${cols <= 3 ? ' {0,3}' : `[ \\t]{0,${cols + 3}}`}${ch}{${fence[2]!.length},}[ \\t]*(?:\\n|$)`,
            'mu'
          );
          const close = closeRe.exec(s.slice(after));
          protect(close ? after + close.index + close[0].length : s.length);
          canIndent = !inList;
          continue;
        }
      }
      const def = execAt(LINK_DEF, s, i);
      if (def) {
        protect(i + def[0].length);
        inList = canIndent = false;
        continue;
      }
      const list = execAt(LIST_LINE, s, i);
      if (list && (indentCols(list[1]!) <= 3 || inList)) inList = true;
      else if (!execAt(INDENTED_CODE, s, i)) inList = false;
      canIndent = atStart = false;
    }

    const ch = s[i];
    if (ch === '\n') {
      flush(i + 1);
      i = plain = i + 1;
      atStart = true;
    } else if (ch === '\\' && i + 1 < s.length && ASCII_PUNCT.test(s[i + 1]!)) {
      protect(i + 2);
    } else if (ch === '`') {
      let end = matchCodeSpan(s, i);
      if (end === -1) for (end = i; s[end] === '`'; end += 1);
      protect(end);
    } else if (ch === '[' || (ch === '!' && s[i + 1] === '[')) {
      const close = matchMarkdownLink(s, i);
      if (close !== -1) protect(close);
      else i += 1;
    } else if (ch === '<' && s.startsWith('<!--', i)) {
      const close = s.indexOf('-->', i + 4);
      if (close === -1) {
        i += 4;
        continue;
      }
      flush(i);
      const lastNl = out.lastIndexOf('\n');
      const trail = /^[ \t]*$/u.test(out.slice(lastNl + 1))
        ? execAt(TRAILING_COMMENTS, s, close + 3)
        : null;
      if (trail) {
        out = out.slice(0, lastNl + 1);
        i = Math.min(close + 3 + trail[0].length + 1, s.length);
        if (out.length === 0 || out.endsWith('\n\n')) {
          const blanks = execAt(BLANK_LINES, s, i);
          if (blanks) i += blanks[0].length;
        }
        if (/^[ \t\n]*$/u.test(s.slice(i))) {
          i = s.length;
          out = out.replace(/(?:\n[ \t]*)+$/u, '');
        }
        atStart = true;
        if (out.length === 0 || out.endsWith('\n\n')) canIndent = !inList;
      } else {
        i = close + 3;
      }
      plain = i;
    } else if (ch === '<') {
      const angle = execAt(ANGLE_PROTECTED, s, i);
      if (angle) protect(i + angle[0].length);
      else i += 1;
    } else {
      i += 1;
    }
  }

  flush(s.length);
  return out.trim().length === 0 ? null : out;
}
