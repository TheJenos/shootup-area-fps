import { useEffect, useRef, useState } from 'react';
import { Game } from '../game/game';
import type { Session } from './App';
import { Hud } from './Hud';
import { friendlyError } from './errors';

declare global {
  interface Window {
    /** Exposed in dev builds for poking at the game from the console, and in `--mode e2e` builds for the e2e tests. */
    game?: Game;
  }
}

interface Props {
  session: Session;
  /** Return to the lobby, optionally with an error to show there. */
  onExit(error?: string): void;
}

/** Owns the Game instance for as long as the player is in a room. */
export function GameView({ session, onExit }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [game, setGame] = useState<Game | null>(null);
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const instance = new Game({ host, ...session });
    setGame(instance);
    if (import.meta.env.DEV || import.meta.env.VITE_E2E === 'true') window.game = instance;

    instance.start()
      .then(() => { if (session.notice) instance.hud.pushInfo(session.notice); })
      .catch((err: unknown) => {
        console.error(err);
        onExitRef.current(`Could not join room: ${friendlyError(err)}`);
      });

    return () => {
      if (window.game === instance) window.game = undefined;
      instance.dispose().catch((err: unknown) => console.warn('Failed to leave room cleanly', err));
    };
  }, [session]);

  return (
    <section id="game-screen" className="screen">
      <div id="canvas-host" ref={hostRef} />
      {game && <Hud game={game} roomCode={session.roomCode} onLeave={() => onExit()} />}
    </section>
  );
}
