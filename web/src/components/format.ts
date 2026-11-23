export function formatDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? ''
    : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function formatScore(score: number | null): string {
  return score === null ? '' : score.toFixed(2);
}
