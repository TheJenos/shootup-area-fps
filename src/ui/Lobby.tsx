import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { isConfigured } from '../net/firebase';
import { watchRooms, createRoom, getRoomSetup, randomId } from '../net/network';
import { generateMap, normalizeSeed, randomSeed, SEED_MAX_LENGTH } from '../game/mapgen';
import { MapPreview } from './MapPreview';
import { initAudio } from '../game/audio';
import { loadCharacter } from '../game/character';
import { GAME_MODES, MODES } from '../game/modes';
import type { GameMode, RoomSummary } from '../types';
import { ROOM_CODE_MAX, type Session } from './App';
import { Brand } from './Brand';
import { friendlyError } from './errors';
import { Leaderboard } from './Leaderboard';
import { browserProfileId } from '../net/leaderboard';
import { SettingsPanel } from './SettingsPanel';

const NAME_KEY = 'fps-name';

const mapNames = new Map<string, string>();
/** Theme name for a seed (generating a map is cheap, but the room list re-renders often). */
function mapName(seed: string): string {
  let name = mapNames.get(seed);
  if (!name) {
    name = generateMap(seed).theme.name;
    mapNames.set(seed, name);
  }
  return name;
}

function loadName(): string {
  try {
    return localStorage.getItem(NAME_KEY) || '';
  } catch {
    return '';
  }
}

function saveName(name: string): void {
  try {
    localStorage.setItem(NAME_KEY, name);
  } catch { /* storage unavailable */ }
}

/** How long the room list may stay on "Loading…" before we call it a failure (ms) */
const ROOMS_TIMEOUT_MS = 8_000;

/** Live list of open rooms; `rooms` is `null` while loading. `failed` offers a retry. */
function useRooms(): { rooms: RoomSummary[] | null; failed: boolean; retry(): void } {
  const [rooms, setRooms] = useState<RoomSummary[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!isConfigured) return;
    let got = false;
    const timer = setTimeout(() => { if (!got) setFailed(true); }, ROOMS_TIMEOUT_MS);
    const stop = watchRooms((list) => {
      got = true;
      clearTimeout(timer);
      setFailed(false);
      setRooms(list);
    }, () => setFailed(true));
    return () => {
      clearTimeout(timer);
      stop();
    };
  }, [attempt]);
  const retry = () => {
    setRooms(null);
    setFailed(false);
    setAttempt((a) => a + 1);
  };
  return { rooms, failed, retry };
}

type Invite = 'auto' | 'manual' | 'closed' | null;

interface Props {
  initialCode: string;
  initialError: string;
  onEnter(session: Session): void;
}

export function Lobby({ initialCode, initialError, onEnter }: Props) {
  const [name, setName] = useState(loadName);
  const [roomName, setRoomName] = useState('');
  const [mode, setMode] = useState<GameMode>('ffa');
  const [seed, setSeed] = useState(randomSeed);
  // Blank means "surprise me": a fresh random seed is used when the room is created.
  const map = useMemo(() => (seed ? generateMap(seed) : null), [seed]);
  const [code, setCode] = useState(initialCode);
  const [error, setError] = useState(initialError);
  /** What we're doing, and which listed room's button should spin */
  const [busy, setBusy] = useState<'join' | 'create' | null>(null);
  const [joiningCode, setJoiningCode] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const { rooms, failed: roomsFailed, retry: retryRooms } = useRooms();
  const nameRef = useRef<HTMLInputElement>(null);
  const [profileId] = useState(browserProfileId);
  const codeRef = useRef<HTMLInputElement>(null);
  // Start downloading the player model while the user is still in the lobby.
  useEffect(() => { loadCharacter().catch(() => {}); }, []);
  // Opened from an invite link: with a saved name, a short countdown then straight in (with a way out);
  // without one, the code is pre-filled and we ask for a name.
  const [invite, setInvite] = useState<Invite>(() =>
    (initialCode && isConfigured && !initialError ? (loadName().trim() ? 'auto' : 'manual') : null));
  useEffect(() => {
    if (invite !== 'auto') return;
    const timer = setTimeout(() => { void join(initialCode); }, 2000);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [invite]);
  const hasName = name.trim().length > 0;
  const disabled = !!busy || !isConfigured;

  /** Validates the name and runs `action` with the lobby locked. */
  const run = async (kind: 'join' | 'create', action: (playerName: string) => Promise<void>) => {
    const playerName = name.trim().slice(0, 16);
    if (!playerName) {
      setError('Enter a name first.');
      nameRef.current?.focus();
      nameRef.current?.scrollIntoView({ block: 'center' });
      return;
    }
    if (busy) return;
    saveName(playerName);
    initAudio();
    setBusy(kind);
    setError('');
    try {
      await action(playerName);
    } catch (err) {
      console.error(err);
      setError(friendlyError(err));
      setBusy(null);
      setJoiningCode('');
    }
  };

  const join = (roomCode: string) => {
    const normalized = roomCode.trim().toUpperCase();
    setJoiningCode(normalized);
    return run('join', async (playerName) => {
      if (!normalized) throw new Error('Enter a room code.');
      const setup = await getRoomSetup(normalized);
      if (!setup) {
        if (normalized === initialCode) {
          // The invite points at a room that's gone: say so and clear the stale code.
          setInvite('closed');
          setCode('');
          history.replaceState(null, '', location.pathname);
        }
        throw new Error(`Room ${normalized} doesn't exist.`);
      }
      onEnter({ roomCode: normalized, playerId: randomId(), name: playerName, seed: setup.seed, profileId });
    });
  };

  const create = () => run('create', async (playerName) => {
    const playerId = randomId();
    const title = roomName.trim().slice(0, 24) || `${playerName}'s room`;
    const roomSeed = seed || randomSeed();
    const roomCode = await createRoom(title, mode, roomSeed, playerName, playerId);
    onEnter({ roomCode, playerId, name: playerName, seed: roomSeed, profileId });
  });

  /** Enter in the name field: join if a code is filled in, otherwise move on to the code. */
  const onNameKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (!hasName) return;
    if (code.trim()) void join(code);
    else codeRef.current?.focus();
  };

  const submit = (action: () => Promise<void>) => (e: FormEvent) => {
    e.preventDefault();
    void action();
  };

  return (
    <section id="lobby" className="screen">
      <div className="card lobby-card">
        <header className="lobby-head">
        <Brand />
        {invite === 'auto' ? (
          <div className="invite-card" role="status">
            <p>
              {busy === 'join' ? <span className="spinner" aria-hidden="true" /> : null}
              Joining room <strong>{initialCode}</strong> as <strong>{name.trim()}</strong>…
            </p>
            <div className="row">
              <button type="button" className="primary" disabled={disabled} onClick={() => void join(initialCode)}>Join now</button>
              <button type="button" disabled={disabled} onClick={() => { setInvite('manual'); setTimeout(() => nameRef.current?.select(), 0); }}>
                Change name
              </button>
            </div>
            {busy !== 'join' && <div className="progress" aria-hidden="true" />}
          </div>
        ) : invite === 'manual' ? (
          <p className="subtitle invite">
            You've been invited to room <strong>{initialCode}</strong>
            {!hasName && <> — pick a name and hit Join</>}
          </p>
        ) : invite === 'closed' ? (
          <div className="warning">That room has closed — create a new one below, or ask for a fresh invite.</div>
        ) : (
          <p className="subtitle">Pick a name, open a room, frag your friends.</p>
        )}
        </header>

        <section className="lobby-setup">

        {!isConfigured && (
          <div className="warning">
            Firebase isn't configured. Copy <code>.env.example</code> to <code>.env</code> and fill in your
            project's web config, or run <code>npm run emulator</code> + <code>npm run dev:emu</code>.
          </div>
        )}

        <label className="field">
          <span>Your name</span>
          <input
            ref={nameRef}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={onNameKey}
            maxLength={16}
            placeholder="e.g. Maverick"
            autoComplete="off"
            autoFocus={invite !== 'auto'}
          />
          {!hasName && invite !== 'auto' && <small className="muted hint">Pick a name to join or create a room</small>}
        </label>

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

        <div className="field">
          <span>Map</span>
          <div className="map-picker">
            {map ? <MapPreview map={map} mode={mode} /> : <div className="map-preview empty">Random map</div>}
            <div className="map-controls">
              <strong>{map ? map.theme.name : 'Surprise me'}</strong>
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
              <small className="muted">
                Same seed, same map. Type one a friend shared, or <code>classic</code> for the original arena.
              </small>
            </div>
          </div>
        </div>

        <form className="row" onSubmit={submit(create)}>
          <input
            value={roomName}
            onChange={(e) => setRoomName(e.target.value)}
            maxLength={24}
            placeholder="Room name (optional)"
            autoComplete="off"
          />
          <button className="primary" disabled={disabled || !hasName} title={hasName ? undefined : 'Enter a name first'}>
            {busy === 'create' ? <><span className="spinner" aria-hidden="true" />Creating…</> : 'Create room'}
          </button>
        </form>

        <form className="row" onSubmit={submit(() => join(code))}>
          <input
            id="code-input"
            ref={codeRef}
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))}
            maxLength={ROOM_CODE_MAX}
            placeholder="Room code"
            autoComplete="off"
          />
          <button disabled={disabled || !hasName} title={hasName ? undefined : 'Enter a name first'}>
            {busy === 'join' && joiningCode === code.trim().toUpperCase() ? <><span className="spinner" aria-hidden="true" />Joining…</> : 'Join'}
          </button>
        </form>

        <p className="error">{error}</p>

        <button type="button" className="settings-link" onClick={() => setSettingsOpen(true)}>
          ⚙ Mouse &amp; key settings
        </button>
        </section>

        <section className="lobby-rooms">
        <h2>Open rooms</h2>
        <ul id="room-list">
          {!isConfigured ? (
            <li className="empty">Not connected to Firebase</li>
          ) : roomsFailed ? (
            <li className="empty">Couldn't reach the server <button type="button" onClick={retryRooms}>Retry</button></li>
          ) : rooms === null ? (
            <li className="empty"><span className="spinner" aria-hidden="true" />Loading…</li>
          ) : rooms.length === 0 ? (
            <li className="empty">No open rooms yet — create one!</li>
          ) : (
            rooms.map((room) => (
              <li key={room.code}>
                <div className="info">
                  <div className="name">
                    <span className={`mode-badge ${room.mode}`}>{MODES[room.mode].short}</span>
                    {room.name}
                  </div>
                  <div className="meta">
                    {room.code} · {mapName(room.seed)} · {room.players.length} playing ·{' '}
                    {room.players.slice(0, 4).join(', ')}
                  </div>
                </div>
                <button disabled={disabled || !hasName} title={hasName ? undefined : 'Enter a name first'} onClick={() => void join(room.code)}>
                  {busy === 'join' && joiningCode === room.code ? <><span className="spinner" aria-hidden="true" />Joining…</> : 'Join'}
                </button>
              </li>
            ))
          )}
        </ul>
        <Leaderboard limit={20} me={profileId} />
        </section>

        <p className="legal muted"><a href="/terms.html" target="_blank" rel="noreferrer">Terms</a> · <a href="/privacy.html" target="_blank" rel="noreferrer">Privacy</a></p>
      </div>
      {settingsOpen && <SettingsPanel onClose={() => setSettingsOpen(false)} />}
    </section>
  );
}
