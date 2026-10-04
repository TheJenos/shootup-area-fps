export const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * What to show a player when something fails. Firebase's own messages ("PERMISSION_DENIED: …",
 * "Failed to fetch") become plain sentences; messages we wrote ourselves pass through. In dev
 * builds the raw message is appended so the cause is still visible.
 */
export function friendlyError(err: unknown): string {
  const raw = errorMessage(err);
  const code = (err as { code?: unknown } | null)?.code;
  const text = `${typeof code === 'string' ? code : ''} ${raw}`;
  let friendly: string;
  if (/permission[_ ]denied/i.test(text)) friendly = 'The server refused that request. Try again, or reload the page.';
  else if ((typeof navigator !== 'undefined' && navigator.onLine === false) || /network|failed to fetch|offline|unavailable|disconnected/i.test(text)) {
    friendly = 'You seem to be offline. Check your connection and try again.';
  } else if (/timeout|timed out/i.test(text)) friendly = 'The server took too long to respond.';
  else if (typeof code === 'string' || /^[A-Z_]{4,}(:|$)/.test(raw)) friendly = 'Something went wrong talking to the server.';
  else return raw;
  return import.meta.env.DEV && friendly !== raw ? `${friendly} (${raw})` : friendly;
}
