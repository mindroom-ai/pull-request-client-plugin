import { afterEach, describe, expect, it, vi } from 'vitest';
import { imageResolver, imageSources } from './images';

const UUID = 'e96b9445-1c5a-4051-86f8-e237dabb865f';
const SIGNED = `https://private-user-images.githubusercontent.com/12/345-${UUID}.png?jwt=ey.J&v=1`;
const CAMO = 'https://camo.githubusercontent.com/4f/68747470';
const BADGE = 'https://img.shields.io/badge/license-MIT-blue.svg';
const NONE = { byUrl: {}, byAttachment: {} };

describe('imageSources', () => {
  it("maps an attachment's UUID to its signed address and an image's original URL to camo", () => {
    const html = [
      `<p><a href="${SIGNED.replace('&', '&amp;')}" rel="nofollow"><img src="${SIGNED.replace(
        '&',
        '&amp;'
      )}" alt="Before: icon > center" style="max-width: 100%;"></a></p>`,
      `<p><img src='${CAMO}' data-canonical-src="${BADGE}?a=1&amp;b=2" alt=""></p>`,
    ].join('\n');
    expect(imageSources(html)).toEqual({
      byUrl: { [`${BADGE}?a=1&b=2`]: CAMO },
      byAttachment: { [UUID]: SIGNED },
    });
  });

  it('keeps no address off GitHub or without https', () => {
    const html = [
      `<img src="https://evil.example/${UUID}.png" data-canonical-src="${BADGE}">`,
      `<img src="http://camo.githubusercontent.com/x" data-canonical-src="${BADGE}">`,
      `<img src="https://u:p@camo.githubusercontent.com/x" data-canonical-src="${BADGE}">`,
      `<img src="https://githubusercontent.com.evil.example/x" data-canonical-src="${BADGE}">`,
    ].join('');
    expect(imageSources(html)).toEqual(NONE);
  });

  it('is empty without HTML', () => {
    expect(imageSources(undefined)).toEqual(NONE);
    expect(imageSources(null)).toEqual(NONE);
    expect(imageSources('<p>no images</p>')).toEqual(NONE);
  });
});

/** A signed attachment address whose `jwt` expires at `exp` (seconds), as GitHub mints them. */
function signedAt(uuid: string, exp: number, salt: string): string {
  const base64url = (value: object) =>
    btoa(JSON.stringify(value)).replace(/=+$/u, '').replace(/\+/gu, '-').replace(/\//gu, '_');
  const jwt = `${base64url({ alg: 'HS256' })}.${base64url({ exp, key: salt })}.sig${salt}`;
  return `https://private-user-images.githubusercontent.com/1/2-${uuid}.png?jwt=${jwt}`;
}
const imgOf = (src: string) => `<p><img src="${src}" alt=""></p>`;

describe('imageSources, fetched again', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps the signed address handed out while it is valid, so answers stay equal', () => {
    vi.useFakeTimers({ now: 1_000_000_000_000 });
    const uuid = 'aaaaaaaa-0000-0000-0000-000000000001';
    const exp = 1_000_000_000 + 300;
    const first = imageSources(imgOf(signedAt(uuid, exp, 'one')));
    vi.advanceTimersByTime(120_000);
    const second = imageSources(imgOf(signedAt(uuid, exp + 120, 'two')));
    expect(second.byAttachment[uuid]).toBe(signedAt(uuid, exp, 'one'));
    expect(second).toEqual(first);
  });

  it('hands out the new address once the one before is about to expire', () => {
    vi.useFakeTimers({ now: 1_000_000_000_000 });
    const uuid = 'aaaaaaaa-0000-0000-0000-000000000002';
    const exp = 1_000_000_000 + 300;
    imageSources(imgOf(signedAt(uuid, exp, 'one')));
    vi.advanceTimersByTime(250_000);
    const fresh = signedAt(uuid, exp + 250, 'two');
    expect(imageSources(imgOf(fresh)).byAttachment[uuid]).toBe(fresh);
    vi.advanceTimersByTime(60_000);
    expect(imageSources(imgOf(signedAt(uuid, exp + 310, 'three'))).byAttachment[uuid]).toBe(fresh);
  });

  it('replaces an address whose jwt it cannot read', () => {
    const uuid = 'aaaaaaaa-0000-0000-0000-000000000003';
    const unreadable = `https://private-user-images.githubusercontent.com/1/2-${uuid}.png?jwt=x.%%.y`;
    imageSources(imgOf(unreadable));
    const fresh = signedAt(uuid, Math.floor(Date.now() / 1000) + 300, 'two');
    expect(imageSources(imgOf(fresh)).byAttachment[uuid]).toBe(fresh);
  });
});

describe('imageResolver', () => {
  const resolve = imageResolver({
    byUrl: { [BADGE]: CAMO },
    byAttachment: { [UUID]: SIGNED },
  });

  it("gives an attachment the signed address, in each of GitHub's forms of its URL", () => {
    expect(resolve(`https://github.com/user-attachments/assets/${UUID}`)).toBe(SIGNED);
    expect(resolve(`https://github.com/a/b/assets/12/${UUID}`)).toBe(SIGNED);
  });

  it('gives an already signed address of the attachment the fresh one', () => {
    const stale = `https://private-user-images.githubusercontent.com/12/345-${UUID}.png?jwt=old`;
    expect(resolve(stale)).toBe(SIGNED);
    expect(
      resolve(`https://private-user-images.githubusercontent.com/12/345-${UUID.toUpperCase()}.png`)
    ).toBe(SIGNED);
    const other =
      'https://private-user-images.githubusercontent.com/1/2-00000000-0000-0000-0000-000000000000.png?jwt=x';
    expect(resolve(other)).toBe(other);
  });

  it('gives an image on another host its camo address', () => {
    expect(resolve(BADGE)).toBe(CAMO);
  });

  it('passes an https image on GitHub through when its HTML had none', () => {
    const other = 'https://github.com/user-attachments/assets/00000000-0000-0000-0000-000000000000';
    expect(resolve(other)).toBe(other);
    expect(resolve('https://raw.githubusercontent.com/a/b/main/x.png')).toBe(
      'https://raw.githubusercontent.com/a/b/main/x.png'
    );
    expect(imageResolver(NONE)(`https://github.com/user-attachments/assets/${UUID}`)).toBe(
      `https://github.com/user-attachments/assets/${UUID}`
    );
  });

  it('drops an image on any other host, without https, or with credentials', () => {
    expect(resolve('https://evil.example/x.png')).toBeUndefined();
    expect(resolve('https://githubusercontent.com.evil.example/x.png')).toBeUndefined();
    expect(resolve('http://github.com/x.png')).toBeUndefined();
    expect(resolve('https://u:p@github.com/x.png')).toBeUndefined();
    expect(resolve('javascript:alert(1)')).toBeUndefined();
    expect(resolve('x.png')).toBeUndefined();
    expect(resolve(UUID)).toBeUndefined();
    expect(resolve('constructor')).toBeUndefined();
  });
});
