import { useEffect, useMemo, useState } from 'react';
import { connectDiscord, type DiscordSession } from '../discord/discord';
import { createRoomWithCode, getRoomSetup, randomId } from '../net/network';
import { initAudio } from '../game/audio';
import { loadCharacter } from '../game/character';
import { loadGunModels } from '../game/guns';
import { loadFpArms } from '../game/fpArms';
import { loadPropModels } from '../game/props';
import { ModePicker } from './ModePicker';
import { PRESETS, type ModeRules } from '../game/rules';
import { generateMap, layoutName, mapName, normalizeSeed, randomSeed, SEED_MAX_LENGTH } from '../game/mapgen';
import { MapPreview } from './MapPreview';
import { RoomBrowser, useRooms } from './RoomBrowser';
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

type Existing = { rules: ModeRules; seed: string } | null;
type Tab = 'channel' | 'rooms' | 'leaderboard';

interface Props {
  initialError: string;
  onEnter(session: Session): void;
}

/** Start screen inside Discord: the player is already signed in, the room is the voice channel's. */
export function DiscordLobby({ initialError, onEnter }: Props) {
  const [discord, setDiscord] = useState<DiscordSession | null>(null);
  const [existing, setExisting] = useState<Existing | undefined>(undefined);
  const [rules, setRules] = useState<ModeRules>(PRESETS[0]!.rules);
  const [error, setError] = useState(initialError);
  const [busy, setBusy] = useState(false);
  /** Which listed room's Join button should spin (Open rooms tab) */
  const [joiningCode, setJoiningCode] = useState('');
  const [tab, setTab] = useState<Tab>('channel');
  const [seed, setSeed] = useState(randomSeed);
  const map = useMemo(() => (seed ? generateMap(seed) : null), [seed]);
  const { rooms, failed: roomsFailed, retry: retryRooms } = useRooms();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const roomCode = discord ? roomCodeFor(discord.instanceId) : '';

  useEffect(() => {
    let cancelled = false;
    loadCharacter().catch(() => {});
    loadGunModels().catch(() => {});
    loadFpArms().catch(() => {});
    loadPropModels().catch(() => {});
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
      const created = existing ? false
        : await createRoomWithCode(roomCode, 'Discord match', rules, seed || randomSeed(), discord.name, playerId);
      const setup = await getRoomSetup(roomCode);
      if (!setup) throw new Error('Could not start the match. Try again.');
      // We lost the race to start: the mode we picked wasn't used.
      const notice = !existing && !created && setup.rules.name !== rules.name
        ? `Someone started first — you joined their ${setup.rules.name} match`
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

  /** Join any other open room (Open rooms tab), as this Discord account. */
  const joinOther = async (code: string) => {
    if (!discord || busy) return;
    const normalized = code.trim().toUpperCase();
    initAudio();
    setBusy(true);
    setJoiningCode(normalized);
    setError('');
    try {
      const setup = await getRoomSetup(normalized);
      if (!setup) throw new Error(`Room ${normalized} doesn't exist.`);
      onEnter({ roomCode: normalized, playerId: randomId(), name: discord.name, seed: setup.seed, profileId: discordProfileId(discord.userId) });
    } catch (err) {
      console.error(err);
      setError(friendlyError(err));
      setBusy(false);
      setJoiningCode('');
    }
  };

  const tabs: { id: Tab; label: string; count?: number }[] = [
    { id: 'channel', label: 'This channel' },
    { id: 'rooms', label: 'Open rooms', ...(rooms ? { count: rooms.filter((r) => r.code !== roomCode).length } : {}) },
    { id: 'leaderboard', label: 'Leaderboard' },
  ];

  return (
    <section id="lobby" className="screen">
      <div className="card lobby-tabs-card discord">
        <header className="lobby-top">
          <Brand />
          {discord && (
            <div className="lobby-profile">
              <span className="muted">Playing as</span>
              <strong title="Your Discord name">{discord.name}</strong>
              <button type="button" className="icon-button" aria-label="Mouse and key settings" title="Settings" onClick={() => setSettingsOpen(true)}>⚙</button>
            </div>
          )}
        </header>

        {!discord ? (
          <div className="name-setup discord-connect">
            <h2>{error ? 'Could not connect to Discord' : <><span className="spinner" aria-hidden="true" />Connecting to Discord…</>}</h2>
            {error && (
              <>
                <p className="error">{error}</p>
                <button type="button" className="primary" onClick={() => { setError(''); setAttempt((a) => a + 1); }}>Retry</button>
              </>
            )}
          </div>
        ) : (
          <>
            <nav className="tabs" role="tablist" aria-label="Lobby">
              {tabs.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  id={`tab-${t.id}`}
                  aria-selected={tab === t.id}
                  aria-controls={`panel-${t.id}`}
                  className={tab === t.id ? 'tab selected' : 'tab'}
                  onClick={() => setTab(t.id)}
                >
                  {t.label}{t.count !== undefined && <span className="count">{t.count}</span>}
                </button>
              ))}
            </nav>

            {tab === 'channel' && (
              <section id="panel-channel" role="tabpanel" aria-labelledby="tab-channel" className="tab-panel create-panel">
                {existing ? (
                  // A match is already running in this voice channel: one big way in.
                  <div className="channel-match">
                    <div className="match-info">
                      <span className={`mode-badge ${existing.rules.base}`}>{existing.rules.short}</span>
                      <div>
                        <strong>{existing.rules.name}</strong> on <strong>{mapName(existing.seed)}</strong>
                        <p className="muted">A match is running in this voice channel.</p>
                      </div>
                    </div>
                    <button className="primary create-button" disabled={busy} onClick={() => void play()}>
                      {busy ? <><span className="spinner" aria-hidden="true" />Joining…</> : 'Join match'}
                    </button>
                    <p className="error">{error}</p>
                  </div>
                ) : (
                  <div className="create-grid">
                    <div className="field">
                      <span>Game mode</span>
                      <ModePicker value={rules} onChange={setRules} />
                    </div>
                    <div className="create-side">
                      <div className="field">
                        <span>Map</span>
                        <div className="map-picker stacked">
                          {map ? <MapPreview map={map} mode={rules.base} /> : <div className="map-preview empty">Random map</div>}
                          <div className="map-controls">
                            <strong>{map ? layoutName(map) : 'Surprise me'}</strong>
                            <div className="row">
                              <input
                                className="seed-input"
                                value={seed}
                                onChange={(e) => setSeed(normalizeSeed(e.target.value))}
                                maxLength={SEED_MAX_LENGTH}
                                placeholder="Seed"
                                aria-label="Map seed"
                                autoComplete="off"
                              />
                              <button type="button" title="New random map" aria-label="New random map" onClick={() => setSeed(randomSeed())}>🎲</button>
                            </div>
                            <small className="muted">Same seed, same map.</small>
                          </div>
                        </div>
                      </div>
                      <button className="primary create-button" disabled={busy} onClick={() => void play()}>
                        {busy ? <><span className="spinner" aria-hidden="true" />Starting…</> : `Start ${rules.name}`}
                      </button>
                      <p className="muted hint">Everyone in this voice channel plays in the same match.</p>
                      <p className="error">{error}</p>
                    </div>
                  </div>
                )}
              </section>
            )}

            {tab === 'rooms' && (
              <section id="panel-rooms" role="tabpanel" aria-labelledby="tab-rooms" className="tab-panel">
                <RoomBrowser
                  rooms={rooms}
                  failed={roomsFailed}
                  retry={retryRooms}
                  hide={roomCode}
                  busy={busy}
                  joiningCode={joiningCode}
                  disabled={busy}
                  error={error}
                  onJoin={(c) => void joinOther(c)}
                  onCreate={() => setTab('channel')}
                />
              </section>
            )}

            {tab === 'leaderboard' && (
              <section id="panel-leaderboard" role="tabpanel" aria-labelledby="tab-leaderboard" className="tab-panel">
                <Leaderboard limit={20} me={discordProfileId(discord.userId)} />
              </section>
            )}
          </>
        )}

        <p className="legal muted"><a href="/terms.html" target="_blank" rel="noreferrer">Terms</a> · <a href="/privacy.html" target="_blank" rel="noreferrer">Privacy</a> · <a href="/credits.html" target="_blank" rel="noreferrer">Credits</a></p>
      </div>
      {settingsOpen && <SettingsPanel onClose={() => setSettingsOpen(false)} />}
    </section>
  );
}
