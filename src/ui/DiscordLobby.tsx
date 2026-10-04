import { useEffect, useState } from 'react';
import { connectDiscord, type DiscordSession } from '../discord/discord';
import { createRoomWithCode, getRoomSetup, randomId } from '../net/network';
import { initAudio } from '../game/audio';
import { loadCharacter } from '../game/character';
import { GAME_MODES, MODES } from '../game/modes';
import { generateMap, randomSeed } from '../game/mapgen';
import type { GameMode } from '../types';
import type { Session } from './App';
import { Brand } from './Brand';
import { friendlyError } from './errors';
import { SettingsPanel } from './SettingsPanel';
import { Leaderboard } from './Leaderboard';
import { discordProfileId } from '../net/leaderboard';

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
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [attempt, setAttempt] = useState(0);
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
      .catch((err: unknown) => { if (!cancelled) setError(friendlyError(err)); });
    return () => { cancelled = true; };
  }, [attempt]);

  const play = async () => {
    if (!discord || busy) return;
    initAudio();
    setBusy(true);
    setError('');
    try {
      const playerId = randomId();
      // Someone may have started the match since we looked; then we just join theirs.
      const seed = randomSeed();
      const created = existing ? false : await createRoomWithCode(roomCode, 'Discord match', mode, seed, discord.name, playerId);
      const setup = await getRoomSetup(roomCode);
      if (!setup) throw new Error('Could not start the match. Try again.');
      // We lost the race to start: the mode we picked wasn't used.
      const notice = !existing && !created && setup.mode !== mode
        ? `Someone started first — you joined their ${MODES[setup.mode].name} match`
        : undefined;
      onEnter({
        roomCode, playerId, name: discord.name, seed: setup.seed, profileId: discordProfileId(discord.userId), ...(notice ? { notice } : {}),
      });
    } catch (err) {
      console.error(err);
      setError(friendlyError(err));
      setBusy(false);
    }
  };

  return (
    <section id="lobby" className="screen">
      <div className="card discord lobby-card">
        <header className="lobby-head">
          <Brand />
        </header>
        <section className="lobby-setup">
        {!discord ? (
          <>
            <p className="subtitle">
              {error ? 'Could not connect to Discord.' : <><span className="spinner" aria-hidden="true" />Connecting to Discord…</>}
            </p>
            {error && <button type="button" onClick={() => { setError(''); setAttempt((a) => a + 1); }}>Retry</button>}
          </>
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
              {busy ? <><span className="spinner" aria-hidden="true" />{existing ? 'Joining…' : 'Starting…'}</> : existing ? 'Join match' : 'Start match'}
            </button>
            <p className="muted hint">Everyone in this voice channel plays in the same match.</p>
          </>
        )}
        <p className="error">{error}</p>
        <button type="button" className="settings-link" onClick={() => setSettingsOpen(true)}>
          ⚙ Mouse &amp; key settings
        </button>
        </section>
        {/* Shown straight away, even while Discord is still signing in (your row lights up once it has). */}
        <section className="lobby-rooms">
          <Leaderboard limit={20} me={discord ? discordProfileId(discord.userId) : ''} />
        </section>
        <p className="legal muted"><a href="/terms.html" target="_blank" rel="noreferrer">Terms</a> · <a href="/privacy.html" target="_blank" rel="noreferrer">Privacy</a></p>
      </div>
      {settingsOpen && <SettingsPanel onClose={() => setSettingsOpen(false)} />}
    </section>
  );
}
