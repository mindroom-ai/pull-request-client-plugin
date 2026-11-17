import { describe, expect, it } from 'vitest';
import { imageResolver, imageSources, signedFallback } from './images';

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

  it("maps no attachment's URL to its signed address, which changes in every answer", () => {
    const html = `<img src="${SIGNED}" data-canonical-src="https://github.com/user-attachments/assets/${UUID}">`;
    expect(imageSources(html)).toEqual({ byUrl: {}, byAttachment: { [UUID]: SIGNED } });
  });

  it('is empty without HTML', () => {
    expect(imageSources(undefined)).toEqual(NONE);
    expect(imageSources(null)).toEqual(NONE);
    expect(imageSources('<p>no images</p>')).toEqual(NONE);
  });
});

describe('imageResolver', () => {
  const resolve = imageResolver({
    byUrl: { [BADGE]: CAMO },
    byAttachment: { [UUID]: SIGNED },
  });

  it("keeps an attachment's stable address, in each of GitHub's forms of it", () => {
    expect(resolve(`https://github.com/user-attachments/assets/${UUID}`)).toBe(
      `https://github.com/user-attachments/assets/${UUID}`
    );
    expect(resolve(`https://github.com/a/b/assets/12/${UUID}`)).toBe(
      `https://github.com/a/b/assets/12/${UUID}`
    );
  });

  it("gives an already signed address the attachment's signed address in the HTML", () => {
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

describe('signedFallback', () => {
  const sources = { byUrl: { [BADGE]: CAMO }, byAttachment: { [UUID]: SIGNED } };

  it("gives a failed attachment the signed address in the HTML, in each of GitHub's forms", () => {
    expect(signedFallback(sources, `https://github.com/user-attachments/assets/${UUID}`)).toBe(
      SIGNED
    );
    expect(signedFallback(sources, `https://github.com/a/b/assets/12/${UUID.toUpperCase()}`)).toBe(
      SIGNED
    );
  });

  it('gives nothing to the signed address itself, another image, or an unknown attachment', () => {
    expect(signedFallback(sources, SIGNED)).toBeUndefined();
    expect(signedFallback(sources, CAMO)).toBeUndefined();
    expect(signedFallback(sources, BADGE)).toBeUndefined();
    expect(signedFallback(sources, `https://evil.example/user-attachments/assets/${UUID}`)).toBe(
      undefined
    );
    expect(
      signedFallback(
        sources,
        'https://github.com/user-attachments/assets/00000000-0000-0000-0000-000000000000'
      )
    ).toBeUndefined();
    expect(signedFallback(NONE, `https://github.com/user-attachments/assets/${UUID}`)).toBe(
      undefined
    );
  });
});
