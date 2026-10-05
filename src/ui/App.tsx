import { useState } from 'react';
import { Lobby } from './Lobby';
import { GameView } from './GameView';
import { DiscordLobby } from './DiscordLobby';
import { IN_DISCORD } from '../discord/patch';

export interface Session {
  roomCode: string;
  playerId: string;
  name: string;
  /** The room's map seed */
  seed: string;
  /** Something to tell the player once they're in (e.g. the mode they picked wasn't used) */
  notice?: string;
  /** Leaderboard identity: stays the same between visits (or Discord accounts) */
  profileId: string;
  /** Inside a Discord server: its id, so rounds also count on that server's leaderboard */
  guildId?: string | null;
}

/** Room codes are 5 characters, or 10 for Discord voice-channel rooms (DC + 8). */
export const ROOM_CODE_MAX = 10;

export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [error, setError] = useState('');

  const enter = (next: Session) => {
    history.replaceState(null, '', `#${next.roomCode}`);
    setError('');
    setSession(next);
  };

  const exit = (err?: string) => {
    // Keep the query string: inside Discord it carries the Activity's frame_id / instance_id.
    history.replaceState(null, '', location.pathname + location.search);
    setSession(null);
    setError(err ?? '');
  };

  if (session) return <GameView key={session.playerId} session={session} onExit={exit} />;
  if (IN_DISCORD) return <DiscordLobby initialError={error} onEnter={enter} />;
  return <Lobby initialCode={inviteCode()} initialError={error} onEnter={enter} />;
}

/** The room code an invite link points at: `#CODE` or `?room=CODE`. */
function inviteCode(): string {
  const hash = location.hash.slice(1);
  const query = new URLSearchParams(location.search).get('room') ?? '';
  return (hash || query).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, ROOM_CODE_MAX);
}
