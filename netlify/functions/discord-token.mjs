/**
 * Discord Activity sign-in: trade the one-time code from the Discord client for an access
 * token. Runs on Netlify because it needs the app's client secret.
 *
 * Needs DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET in the Netlify site's environment.
 */
export default async (req) => {
  if (req.method !== 'POST') return Response.json({ error: 'POST only' }, { status: 405 });
  const clientId = process.env.DISCORD_CLIENT_ID;
  const clientSecret = process.env.DISCORD_CLIENT_SECRET;
  if (!clientId || !clientSecret) return Response.json({ error: 'not configured' }, { status: 500 });

  let code;
  try {
    ({ code } = await req.json());
  } catch {
    return Response.json({ error: 'bad request' }, { status: 400 });
  }
  if (typeof code !== 'string' || !code || code.length > 200) {
    return Response.json({ error: 'missing code' }, { status: 400 });
  }

  const res = await fetch('https://discord.com/api/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: 'authorization_code', code }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    // Don't pass Discord's response through; it can echo request details.
    return Response.json({ error: 'token exchange failed' }, { status: 400 });
  }
  return Response.json({ access_token: data.access_token });
};
