// An attachment's signed address in GitHub's HTML (`private-user-images`) expires a few minutes
// after GitHub gave it, so an image first shown later fails to load. The query that carried its
// body, fetched again, gives new addresses. At most once a minute per query: an image that is
// really broken must not ask GitHub over and over. A failure within that minute fetches again
// when the minute ends.
import { useEffect, useState } from 'react';
import { useQueryClient, type Query } from '@tanstack/react-query';
import { forgetSigned, type ImageSources } from '../images';

const SIGNED = 'https://private-user-images.githubusercontent.com/';
const MINUTE = 60_000;
const lastRefetch = new WeakMap<Query, number>();
const waiting = new WeakSet<Query>();

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
      // Every failed address is forgotten, also one whose refetch the limit holds back, so the
      // next answer's address replaces it.
      forgetSigned(image.src);
      const query = queryClient
        .getQueryCache()
        .findAll({ queryKey: ['pull-requests'] })
        .find((candidate) => carries(candidate.state.data, images));
      if (!query) return;
      const refetch = () => {
        waiting.delete(query);
        lastRefetch.set(query, Date.now());
        // A fetch already running brings the new addresses too; it is joined, not restarted.
        void queryClient.refetchQueries(
          { queryKey: query.queryKey, exact: true },
          { cancelRefetch: false }
        );
      };
      const wait = (lastRefetch.get(query) ?? -Infinity) + MINUTE - Date.now();
      if (wait <= 0) refetch();
      else if (!waiting.has(query)) {
        waiting.add(query);
        setTimeout(refetch, wait);
      }
    };
    // An image's error does not bubble, but it passes its ancestors on the way down.
    element.addEventListener('error', onError, true);
    return () => element.removeEventListener('error', onError, true);
  }, [element, images, queryClient]);
  return setElement;
}
