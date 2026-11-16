// An attachment's signed address in GitHub's HTML (`private-user-images`) expires a few minutes
// after GitHub gave it, so an image first shown later fails to load. The query that carried its
// body, fetched again, gives new addresses. At most once a minute per query: an image that is
// really broken must not ask GitHub over and over.
import { useEffect, useState } from 'react';
import { useQueryClient, type Query } from '@tanstack/react-query';
import type { ImageSources } from '../images';

const SIGNED = 'https://private-user-images.githubusercontent.com/';
const MINUTE = 60_000;
const lastRefetch = new WeakMap<Query, number>();

/** Whether a query's answer, a pull request or a page of a list, holds the body of these images. */
function carries(data: unknown, images: ImageSources): boolean {
  const holds = (value: unknown) => (value as { images?: unknown } | null)?.images === images;
  const items = (data as { items?: unknown } | null)?.items;
  return holds(data) || (Array.isArray(items) && items.some(holds));
}

/**
 * A ref for the element a body's HTML is drawn in: when a signed image in it fails to load, the
 * query whose answer holds these images is fetched again.
 */
export function useRefetchOnExpiredImage(images: ImageSources) {
  const queryClient = useQueryClient();
  const [element, setElement] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (!element) return;
    const onError = (event: Event) => {
      const image = event.target;
      if (!(image instanceof HTMLImageElement) || !image.src.startsWith(SIGNED)) return;
      const query = queryClient
        .getQueryCache()
        .findAll({ queryKey: ['pull-requests'] })
        .find((candidate) => carries(candidate.state.data, images));
      if (!query) return;
      const last = lastRefetch.get(query);
      if (last !== undefined && Date.now() - last < MINUTE) return;
      lastRefetch.set(query, Date.now());
      void queryClient.refetchQueries({ queryKey: query.queryKey, exact: true });
    };
    // An image's error does not bubble, but it passes its ancestors on the way down.
    element.addEventListener('error', onError, true);
    return () => element.removeEventListener('error', onError, true);
  }, [element, images, queryClient]);
  return setElement;
}
