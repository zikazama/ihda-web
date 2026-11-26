export function formatUtcTimestamp(isoString: string | null): string {
  if (!isoString) {
    return 'Never (no successful sync)';
  }
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) {
    return 'Invalid timestamp';
  }
  const iso = date.toISOString();
  return iso.slice(0, 10) + ' ' + iso.slice(11, 19) + ' UTC';
}
