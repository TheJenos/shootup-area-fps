import { useEffect, useState } from 'react';
import { connectDiscord, type DiscordSession } from '../discord/discord';
import { createRoomWithCode, getRoomSetup, randomId } from '../net/network';
import { initAudio } from '../game/audio';
import { loadCharacter } from '../game/character';
import { GAME_MODES, MODES } from '../game/modes';
import { generateMap, randomSeed } from '../game/mapgen';
import type { GameMode } from '../types';
import type { Session } from './App';
import { errorMessage } from './errors';

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** A room code for this Activity instance, so everyone in the voice channel shares one room. */
function roomCodeFor(instanceId: string): string {
  let h = 2166136261;
  let code = 'DC';
  for (let i = 0; i < 8; i++) {
    for (const ch of instanceId + i) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
    code += CODE_CHARS[h % CODE_CHARS.length];
  }
  return code;
}

type Existing = { mode: GameMode; seed: string } | null;

interface Props {
  initialError: string;
  onEnter(session: Session): void;
}

/** Start screen inside Discord: the player is already signed in, the room is the voice channel's. */
export function DiscordLobby({ initialError, onEnter }: Props) {
  const [discord, setDiscord] = useState<DiscordSession | null>(null);
  const [existing, setExisting] = useState<Existing | undefined>(undefined);
  const [mode, setMode] = useState<GameMode>('ffa');
  const [error, setError] = useState(initialError);
  const [busy, setBusy] = useState(false);
  const roomCode = discord ? roomCodeFor(discord.instanceId) : '';

  useEffect(() => {
    let cancelled = false;
    loadCharacter().catch(() => {});
    connectDiscord()
      .then(async (d) => {
        const setup = await getRoomSetup(roomCodeFor(d.instanceId));
        if (cancelled) return;
        setDiscord(d);
        setExisting(setup);
      })
      .catch((err: unknown) => { if (!cancelled) setError(errorMessage(err)); });
    return () => { cancelled = true; };
  }, []);

  const play = async () => {
    if (!discord || busy) return;
    initAudio();
    setBusy(true);
    setError('');
    try {
      const playerId = randomId();
      // Someone may have started the match since we looked; then we just join theirs.
      const seed = randomSeed();
      if (!existing) await createRoomWithCode(roomCode, 'Discord match', mode, seed, discord.name, playerId);
      const setup = await getRoomSetup(roomCode);
      if (!setup) throw new Error('Could not start the match. Try again.');
      onEnter({ roomCode, playerId, name: discord.name, seed: setup.seed });
    } catch (err) {
      console.error(err);
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <section id="lobby" className="screen">
      <div className="card discord">
        <h1>ARENA<span>FPS</span></h1>
        {!discord ? (
          <p className="subtitle">{error ? 'Could not connect to Discord.' : 'Connecting to Discord…'}</p>
        ) : (
          <>
            <p className="subtitle">Playing as <strong>{discord.name}</strong></p>
            {existing ? (
              <div className="match-info">
                <span className={`mode-badge ${existing.mode}`}>{MODES[existing.mode].short}</span>
                {MODES[existing.mode].name} on <strong>{generateMap(existing.seed).theme.name}</strong>
                <p className="muted">A match is running in this channel.</p>
              </div>
            ) : (
              <div className="field">
                <span>Game mode</span>
                <div className="modes" role="radiogroup" aria-label="Game mode">
                  {GAME_MODES.map((m) => (
                    <button
                      key={m}
                      type="button"
                      role="radio"
                      aria-checked={mode === m}
                      className={mode === m ? 'mode selected' : 'mode'}
                      onClick={() => setMode(m)}
                    >
                      <strong>{MODES[m].name}</strong>
                      <small>{MODES[m].description}</small>
                    </button>
                  ))}
                </div>
              </div>
            )}
            <button className="primary play" disabled={busy} onClick={() => void play()}>
              {existing ? 'Join match' : 'Start match'}
            </button>
            <p className="muted hint">Everyone in this voice channel plays in the same match. Desktop only.</p>
          </>
        )}
        <p className="error">{error}</p>
        <p className="legal muted"><a href="/terms.html" target="_blank" rel="noreferrer">Terms</a> · <a href="/privacy.html" target="_blank" rel="noreferrer">Privacy</a></p>
      </div>
    </section>
  );
}
