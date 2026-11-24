// Intersection observers that report only when a test tells them to.
export const observers: FakeIntersectionObserver[] = [];

export class FakeIntersectionObserver {
  readonly targets = new Set<Element>();
  readonly callback: IntersectionObserverCallback;
  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback;
    observers.push(this);
  }
  observe(target: Element) {
    this.targets.add(target);
  }
  unobserve(target: Element) {
    this.targets.delete(target);
  }
  disconnect() {
    this.targets.clear();
  }
}

/** Reports to each observer that its matching elements are on screen, or not. */
export const report = (isIntersecting: boolean, matches = (_target: Element) => true) => {
  for (const observer of observers) {
    const entries = [...observer.targets]
      .filter(matches)
      .map((target) => ({ target, isIntersecting }) as IntersectionObserverEntry);
    if (entries.length > 0) {
      observer.callback(entries, observer as unknown as IntersectionObserver);
    }
  }
};
