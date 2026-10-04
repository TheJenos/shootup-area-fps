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
}

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
  return <Lobby initialCode={location.hash.slice(1).toUpperCase()} initialError={error} onEnter={enter} />;
}
