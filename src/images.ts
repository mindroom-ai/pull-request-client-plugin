// Where the images of a pull request's description and comments load from. GitHub's Markdown keeps
// the address the author wrote, which for a private repository's attachment answers only with
// GitHub's session; GitHub's own HTML of the same text (`body_html`) has the addresses that load:
// an attachment's signed `private-user-images` URL (valid for a few minutes, new in each answer)
// and, for an image on another host, its camo proxy. The panel draws an attachment from its stable
// address and tries the signed one only when that fails. It stays free of the DOM, so it also runs
// in node.

/**
 * The addresses GitHub's HTML of one body gives its images, each an https URL on GitHub: by an
 * image's original URL (its `data-canonical-src`), and by an attachment's UUID.
 */
export type ImageSources = { byUrl: Record<string, string>; byAttachment: Record<string, string> };

export const own = <T>(map: Record<string, T>, key: string): T | undefined =>
  Object.hasOwn(map, key) ? map[key] : undefined;

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu;
// An `<img>` tag whole, with quoted attribute values that may hold a `>`.
const IMG_TAG = /<img\b((?:[^>"']|"[^"]*"|'[^']*')*)>/giu;
const ATTRIBUTE = /([^\s"'=<>/`]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/gu;
const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

export function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/giu, (entity, name: string) => {
    if (name[0] !== '#') return NAMED[name.toLowerCase()] ?? entity;
    const code =
      name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : Number(name.slice(1));
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
  });
}

export function attributes(tag: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const [, name, double, single, bare] of tag.matchAll(ATTRIBUTE)) {
    const key = name!.toLowerCase();
    // The first of two attributes with one name counts, as in a browser.
    if (!found.has(key)) found.set(key, decodeEntities(double ?? single ?? bare ?? ''));
  }
  return found;
}

export function httpsUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url : null;
  } catch {
    return null;
  }
}

/** An https URL on GitHub itself or one of its content hosts, the only images the panel loads. */
export function onGitHub(url: URL): boolean {
  return url.hostname === 'github.com' || url.hostname.endsWith('.githubusercontent.com');
}

/** The last UUID in a URL's path: an attachment's, in each of GitHub's forms of its address. */
export function lastUuid(path: string): string | undefined {
  return path.match(UUID)?.at(-1)?.toLowerCase();
}

const SIGNED_HOST = 'private-user-images.githubusercontent.com';

/** The image addresses in GitHub's HTML of a body (`body_html`); none when it sent none. */
export function imageSources(html: unknown): ImageSources {
  const sources: ImageSources = { byUrl: {}, byAttachment: {} };
  if (typeof html !== 'string') return sources;
  for (const [, inside] of html.matchAll(IMG_TAG)) {
    const attrs = attributes(inside!);
    const src = httpsUrl(attrs.get('src') ?? '');
    if (!src || !onGitHub(src)) continue;
    const uuid = src.hostname === SIGNED_HOST ? lastUuid(src.pathname) : undefined;
    const canonical = attrs.get('data-canonical-src');
    if (uuid) sources.byAttachment[uuid] = src.href;
    else if (canonical) sources.byUrl[canonical] = src.href;
  }
  return sources;
}

// `https://github.com/user-attachments/assets/<uuid>` and the older
// `https://github.com/<owner>/<repo>/assets/<n>/<uuid>`.
export const ATTACHMENT_PATH =
  /^\/(?:user-attachments\/assets|[^/]+\/[^/]+\/assets\/[0-9]+)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/iu;

/**
 * Where an image of a body loads from: an image on another host from its camo address in GitHub's
 * HTML; an attachment from its stable address, which stays the same in every answer (a pasted
 * signed address gets its attachment's signed address in the HTML); else the image's own URL when
 * it is an https one on GitHub; else nowhere, so that no other host learns who reads the pull
 * request (GitHub proxies those through camo).
 */
export function imageResolver(sources: ImageSources): (src: string) => string | undefined {
  return (src) => {
    const url = httpsUrl(src);
    const mapped = own(sources.byUrl, src) ?? (url ? own(sources.byUrl, url.href) : undefined);
    if (mapped !== undefined) return mapped;
    if (!url || !onGitHub(url)) return undefined;
    const uuid = url.hostname === SIGNED_HOST ? lastUuid(url.pathname) : undefined;
    return (uuid && own(sources.byAttachment, uuid)) || url.href;
  };
}

/**
 * The address to try once an attachment's stable address failed to load: its signed address in
 * GitHub's HTML of the body. A private repository's attachment loads only from there (the stable
 * one needs GitHub's session); for a public one the stable address loads and this never runs.
 * The signed address expires about five minutes after GitHub gave it: an attachment first shown
 * later stays broken until its body is drawn again from a newer answer.
 */
export function signedFallback(sources: ImageSources, src: string): string | undefined {
  const url = httpsUrl(src);
  const uuid = url?.hostname === 'github.com' ? ATTACHMENT_PATH.exec(url.pathname)?.[1] : undefined;
  return uuid && own(sources.byAttachment, uuid.toLowerCase());
}
