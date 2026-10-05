import { DiscordSDK } from '@discord/embedded-app-sdk';
import { FUNCTIONS_URL } from './patch';

export interface DiscordSession {
  /** Same for everyone who joined this Activity in this voice channel: becomes the room */
  instanceId: string;
  userId: string;
  /** The Discord server the Activity runs in (null in DMs and group DMs) */
  guildId: string | null;
  /** Display name, cut to the game's 16 characters */
  name: string;
}

let session: Promise<DiscordSession> | null = null;
let sdkInstance: DiscordSDK | null = null;
let presenceBroken = false;

export interface Presence {
  /** First line, e.g. "Capture the Flag on Frostbite" */
  details: string;
  /** Second line, e.g. "Red 2 – 1 Blue" */
  state: string;
  partySize?: number;
  partyMax?: number;
}

/**
 * Show what's happening in the match on the player's Discord profile ("Playing Arena FPS —
 * CTF on Frostbite, Red 2 – 1 Blue"). Needs the rpc.activities.write scope; does nothing
 * outside Discord or when Discord refuses.
 */
export function setDiscordActivity(p: Presence): void {
  if (!sdkInstance || presenceBroken) return;
  sdkInstance.commands.setActivity({
    activity: {
      type: 0,
      details: p.details.slice(0, 128),
      state: p.state.slice(0, 128),
      ...(p.partySize !== undefined ? { party: { size: [p.partySize, p.partyMax ?? 16] as [number, number] } } : {}),
    },
  }).catch((err: unknown) => {
    console.warn('Discord presence refused', err);
    presenceBroken = true;
  });
}

/**
 * Connect to the Discord client and sign the player in (once per page load).
 * Discord's sign-in gives a one-time code; our Netlify function trades it for an access
 * token (that needs the app's client secret, so it can't happen in the browser).
 */
export function connectDiscord(): Promise<DiscordSession> {
  // A failed attempt isn't kept, so a Retry really reconnects.
  session ??= connect().catch((err: unknown) => {
    session = null;
    throw err;
  });
  return session;
}

async function connect(): Promise<DiscordSession> {
  const clientId = import.meta.env.VITE_DISCORD_CLIENT_ID;
  if (!clientId) throw new Error('VITE_DISCORD_CLIENT_ID is not set for this build.');
  const sdk = new DiscordSDK(clientId);
  await sdk.ready();
  sdkInstance = sdk;

  const { code } = await sdk.commands.authorize({
    client_id: clientId,
    response_type: 'code',
    state: '',
    prompt: 'none',
    scope: ['identify', 'rpc.activities.write'],
  });
  const res = await fetch(`${FUNCTIONS_URL}/discord-token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; error?: string };
  if (!res.ok || !body.access_token) throw new Error(`Discord sign-in failed: ${body.error ?? res.status}`);
  const { user } = await sdk.commands.authenticate({ access_token: body.access_token });

  const name = (user.global_name || user.username || 'Player').trim().slice(0, 16);
  return { instanceId: sdk.instanceId, userId: user.id, guildId: sdk.guildId ?? null, name };
}
