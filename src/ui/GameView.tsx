import { useEffect, useRef, useState } from 'react';
import { Game } from '../game/game';
import { requestMap } from '../game/mapgen/client';
import { isPlayableSpec } from '../game/mapgen';
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

/** The last game's leave(); it runs after the lobby is back on screen. */
let leaving: Promise<void> = Promise.resolve();

/**
 * Resolves once the previous game has left its room. Read rooms only after this: leaving can
 * still remove us, or delete the room if we were the last one in it.
 */
export function afterLeave(): Promise<void> {
  return leaving;
}

/** Owns the Game instance for as long as the player is in a room. */
export function GameView({ session, onExit }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [game, setGame] = useState<Game | null>(null);
  const [building, setBuilding] = useState(true);
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let instance: Game | null = null;
    let cancelled = false;
    setBuilding(true);
    // Build the map off the page first (the game then finds it ready), so the page doesn't freeze.
    const ready = isPlayableSpec(session.map) ? requestMap(session.map).catch(() => null) : Promise.resolve(null);
    void ready.then(() => {
      if (cancelled) return;
      setBuilding(false);
      const game = new Game({ host, ...session });
      instance = game;
      setGame(game);
      if (import.meta.env.DEV || import.meta.env.VITE_E2E === 'true') window.game = game;
      game.start()
        .then(() => { if (session.notice) game.hud.pushInfo(session.notice); })
        .catch((err: unknown) => {
          console.error(err);
          onExitRef.current(`Could not join room: ${friendlyError(err)}`);
        });
    });

    return () => {
      cancelled = true;
      if (!instance) return;
      if (window.game === instance) window.game = undefined;
      leaving = instance.dispose().catch((err: unknown) => console.warn('Failed to leave room cleanly', err));
    };
  }, [session]);

  return (
    <section id="game-screen" className="screen">
      <div id="canvas-host" ref={hostRef} />
      {building && <div className="building-map" role="status"><span className="spinner" aria-hidden="true" />Building map…</div>}
      {game && <Hud game={game} roomCode={session.roomCode} onLeave={() => onExit()} />}
    </section>
  );
}
