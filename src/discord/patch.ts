import { patchUrlMappings } from '@discord/embedded-app-sdk';

/*
 * Inside a Discord Activity the game runs in an iframe at <app-id>.discordsays.com, and
 * Discord's sandbox only lets it reach the outside world through its own proxy, using the
 * URL mappings set in the Developer Portal:
 *
 *   /          -> the game itself (Netlify)
 *   /firebase  -> the Firebase Realtime Database
 *   /api       -> the game's Netlify functions (Discord sign-in token exchange)
 *
 * This module rewrites requests to those hosts onto the proxy. It must be imported before
 * anything else: Firebase grabs the WebSocket constructor the moment its module loads.
 */

/** Discord adds frame_id (and instance_id) to the Activity's URL. */
export const IN_DISCORD = new URLSearchParams(window.location.search).has('frame_id');

/** Netlify functions, as the public site serves them (remapped onto /api inside Discord). */
export const FUNCTIONS_URL = 'https://shootup-arena-fps.netlify.app/.netlify/functions';

if (IN_DISCORD) {
  const dbUrl = import.meta.env.VITE_FIREBASE_DATABASE_URL;
  const dbHost = dbUrl ? new URL(dbUrl).host : '';
  // e.g. ".asia-southeast1.firebasedatabase.app"
  const dbDomain = dbHost.slice(dbHost.indexOf('.'));

  // Firebase remembers the "shard" server it was last redirected to (s-apse1a-nss-...), whose
  // name isn't known in advance so it can't be mapped. Forget it, and see below.
  try {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith('firebase:host:')) localStorage.removeItem(key);
    }
  } catch { /* storage unavailable */ }

  patchUrlMappings([
    ...(dbHost ? [{ prefix: '/firebase', target: dbHost }] : []),
    { prefix: '/api', target: new URL(FUNCTIONS_URL).host + new URL(FUNCTIONS_URL).pathname },
  ]);

  // Point any shard host back at the database's main host (which serves the same data), so it
  // goes through the single /firebase mapping. Wraps the SDK's patched WebSocket.
  const Mapped = window.WebSocket;
  class ToMainHost extends Mapped {
    constructor(url: string | URL, protocols?: string | string[]) {
      const next = new URL(url.toString(), window.location.href);
      if (dbHost && next.host !== dbHost && next.host.endsWith(dbDomain)) next.host = dbHost;
      super(next, protocols);
    }
  }
  window.WebSocket = ToMainHost;
}
