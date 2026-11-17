// A private repository's attachment does not load from its stable address (that needs GitHub's
// session), so an attachment that fails tries its signed address in GitHub's HTML of the body,
// once: when that fails too, the image stays broken. Nothing is fetched again. A signed address
// expires about five minutes after GitHub gave it, so in a private repository an attachment first
// shown later stays broken until its body is drawn again from a newer answer.
import { useEffect, useState } from 'react';
import { signedFallback, type ImageSources } from '../images';

/** A ref for the element a body's HTML is drawn in, whose failed attachments load signed. */
export function useSignedImageFallback(images: ImageSources) {
  const [element, setElement] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (!element) return;
    const onError = (event: Event) => {
      const image = event.target;
      if (!(image instanceof HTMLImageElement)) return;
      const signed = signedFallback(images, image.src);
      if (signed) image.src = signed;
    };
    // An image's error does not bubble, but it passes its ancestors on the way down.
    element.addEventListener('error', onError, true);
    return () => element.removeEventListener('error', onError, true);
  }, [element, images]);
  return setElement;
}
