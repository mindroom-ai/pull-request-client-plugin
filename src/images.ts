// Where the images of a pull request's description and comments load from. GitHub's Markdown keeps
// the address the author wrote, which for a private repository's attachment answers only with
// GitHub's session; GitHub's own HTML of the same text (`body_html`) has the address that loads:
// an attachment's signed `private-user-images` URL (valid for a few minutes) and, for an image on
// another host, its camo proxy. It stays free of the DOM, so it also runs in node.

/**
 * The addresses GitHub's HTML of one body gives its images, each an https URL on GitHub: by an
 * image's original URL (its `data-canonical-src`), and by an attachment's UUID.
 */
export type ImageSources = { byUrl: Record<string, string>; byAttachment: Record<string, string> };

const own = (map: Record<string, string>, key: string): string | undefined =>
  Object.hasOwn(map, key) ? map[key] : undefined;

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu;
// An `<img>` tag whole, with quoted attribute values that may hold a `>`.
const IMG_TAG = /<img\b((?:[^>"']|"[^"]*"|'[^']*')*)>/giu;
const ATTRIBUTE = /([^\s"'=<>/`]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/gu;
const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/giu, (entity, name: string) => {
    if (name[0] !== '#') return NAMED[name.toLowerCase()] ?? entity;
    const code =
      name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : Number(name.slice(1));
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
  });
}

function attributes(tag: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const [, name, double, single, bare] of tag.matchAll(ATTRIBUTE)) {
    const key = name!.toLowerCase();
    // The first of two attributes with one name counts, as in a browser.
    if (!found.has(key)) found.set(key, decodeEntities(double ?? single ?? bare ?? ''));
  }
  return found;
}

function httpsUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url : null;
  } catch {
    return null;
  }
}

/** An https URL on GitHub itself or one of its content hosts, the only images the panel loads. */
function onGitHub(url: URL): boolean {
  return url.hostname === 'github.com' || url.hostname.endsWith('.githubusercontent.com');
}

/** The last UUID in a URL's path: an attachment's, in each of GitHub's forms of its address. */
function lastUuid(path: string): string | undefined {
  return path.match(UUID)?.at(-1)?.toLowerCase();
}

const SIGNED_HOST = 'private-user-images.githubusercontent.com';
// GitHub signs an attachment's address anew in each answer, so the same body would come back with
// other addresses on every fetch, and each image would load again. An address handed out stays
// the answer while it is valid for more than a minute.
const MARGIN = 60_000;
const handedOut = new Map<string, { href: string; expires: number }>();

/** When a signed address stops loading, by the `exp` of its `jwt`; now when it has none. */
function expiry(url: URL): number {
  const payload = url.searchParams.get('jwt')?.split('.')[1] ?? '';
  try {
    const base64 = payload.replace(/-/gu, '+').replace(/_/gu, '/');
    const exp: unknown = JSON.parse(
      atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='))
    )?.exp;
    return typeof exp === 'number' ? exp * 1000 : 0;
  } catch {
    return 0;
  }
}

/** The signed address for an attachment: the one handed out before while it still loads. */
function stableSigned(uuid: string, url: URL): string {
  const now = Date.now();
  for (const [key, entry] of handedOut) if (entry.expires <= now) handedOut.delete(key);
  const before = handedOut.get(uuid);
  if (before && before.expires - now > MARGIN) return before.href;
  handedOut.set(uuid, { href: url.href, expires: expiry(url) });
  return url.href;
}

/** The image addresses in GitHub's HTML of a body (`body_html`); none when it sent none. */
export function imageSources(html: unknown): ImageSources {
  const sources: ImageSources = { byUrl: {}, byAttachment: {} };
  if (typeof html !== 'string') return sources;
  for (const [, inside] of html.matchAll(IMG_TAG)) {
    const attrs = attributes(inside!);
    const src = httpsUrl(attrs.get('src') ?? '');
    if (!src || !onGitHub(src)) continue;
    const uuid = src.hostname === SIGNED_HOST ? lastUuid(src.pathname) : undefined;
    const href = uuid ? stableSigned(uuid, src) : src.href;
    const canonical = attrs.get('data-canonical-src');
    if (canonical) sources.byUrl[canonical] = href;
    if (uuid) sources.byAttachment[uuid] = href;
  }
  return sources;
}

// `https://github.com/user-attachments/assets/<uuid>` and the older
// `https://github.com/<owner>/<repo>/assets/<n>/<uuid>`.
const ATTACHMENT_PATH =
  /^\/(?:user-attachments\/assets|[^/]+\/[^/]+\/assets\/[0-9]+)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/iu;

/**
 * Where an image of a body loads from: the address GitHub's HTML gave it, by its URL or by its
 * attachment's UUID (in a `github.com` attachment URL or an older signed address); else the
 * image's own URL when it is an https one on GitHub; else nowhere, so that no other host learns
 * who reads the pull request (GitHub proxies those through camo).
 */
export function imageResolver(sources: ImageSources): (src: string) => string | undefined {
  return (src) => {
    const url = httpsUrl(src);
    const mapped = own(sources.byUrl, src) ?? (url ? own(sources.byUrl, url.href) : undefined);
    if (mapped !== undefined) return mapped;
    if (!url || !onGitHub(url)) return undefined;
    // An already signed address, as pasted from GitHub, gets the fresh one of its attachment.
    const uuid =
      url.hostname === 'github.com'
        ? ATTACHMENT_PATH.exec(url.pathname)?.[1]?.toLowerCase()
        : url.hostname === SIGNED_HOST
        ? lastUuid(url.pathname)
        : undefined;
    return (uuid && own(sources.byAttachment, uuid)) || url.href;
  };
}
