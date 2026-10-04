import { useState } from 'react';
import { Lobby } from './Lobby';
import { GameView } from './GameView';

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
    history.replaceState(null, '', location.pathname);
    setSession(null);
    setError(err ?? '');
  };

  if (session) return <GameView key={session.playerId} session={session} onExit={exit} />;
  return <Lobby initialCode={location.hash.slice(1).toUpperCase()} initialError={error} onEnter={enter} />;
}
