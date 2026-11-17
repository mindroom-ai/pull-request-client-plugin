// A long name shortened in its middle, so both its start and its end still show.

/**
 * `text` when it has at most `max` code points; else its first and its last code points around
 * an ellipsis, `max` code points in all, the start taking the one more when they cannot be even.
 */
export function middleTruncate(text: string, max: number): string {
  const points = Array.from(text);
  if (points.length <= max) return text;
  const start = Math.ceil((max - 1) / 2);
  const end = Math.floor((max - 1) / 2);
  return `${points.slice(0, start).join('')}…${end > 0 ? points.slice(-end).join('') : ''}`;
}
