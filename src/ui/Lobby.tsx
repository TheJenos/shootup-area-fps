import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { isConfigured } from '../net/firebase';
import { watchRooms, createRoom, getRoomSetup, randomId } from '../net/network';
import { generateMap, normalizeSeed, randomSeed, SEED_MAX_LENGTH } from '../game/mapgen';
import { MapPreview } from './MapPreview';
import { initAudio } from '../game/audio';
import { loadCharacter } from '../game/character';
import { GAME_MODES, MODES } from '../game/modes';
import type { GameMode, RoomSummary } from '../types';
import type { Session } from './App';
import { Brand } from './Brand';
import { errorMessage } from './errors';
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

/** Live list of open rooms; `null` while loading. */
function useRooms(): RoomSummary[] | null {
  const [rooms, setRooms] = useState<RoomSummary[] | null>(null);
  useEffect(() => (isConfigured ? watchRooms(setRooms) : undefined), []);
  return rooms;
}

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
  const [busy, setBusy] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const rooms = useRooms();
  // Start downloading the player model while the user is still in the lobby.
  useEffect(() => { loadCharacter().catch(() => {}); }, []);
  const disabled = busy || !isConfigured;

  /** Validates the name and runs `action` with the lobby locked. */
  const run = async (action: (playerName: string) => Promise<void>) => {
    const playerName = name.trim().slice(0, 16);
    if (!playerName) {
      setError('Enter a name first.');
      return;
    }
    if (busy) return;
    saveName(playerName);
    initAudio();
    setBusy(true);
    setError('');
    try {
      await action(playerName);
    } catch (err) {
      console.error(err);
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  const join = (roomCode: string) => run(async (playerName) => {
    const normalized = roomCode.trim().toUpperCase();
    if (!normalized) throw new Error('Enter a room code.');
    const setup = await getRoomSetup(normalized);
    if (!setup) throw new Error(`Room ${normalized} doesn't exist.`);
    onEnter({ roomCode: normalized, playerId: randomId(), name: playerName, seed: setup.seed });
  });

  const create = () => run(async (playerName) => {
    const playerId = randomId();
    const title = roomName.trim().slice(0, 24) || `${playerName}'s room`;
    const roomSeed = seed || randomSeed();
    const roomCode = await createRoom(title, mode, roomSeed, playerName, playerId);
    onEnter({ roomCode, playerId, name: playerName, seed: roomSeed });
  });

  const submit = (action: () => Promise<void>) => (e: FormEvent) => {
    e.preventDefault();
    void action();
  };

  return (
    <section id="lobby" className="screen">
      <div className="card">
        <Brand />
        <p className="subtitle">Pick a name, open a room, frag your friends.</p>

        {!isConfigured && (
          <div className="warning">
            Firebase isn't configured. Copy <code>.env.example</code> to <code>.env</code> and fill in your
            project's web config, or run <code>npm run emulator</code> + <code>npm run dev:emu</code>.
          </div>
        )}

        <label className="field">
          <span>Your name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={16}
            placeholder="e.g. Maverick"
            autoComplete="off"
          />
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
                <button type="button" title="New random map" onClick={() => setSeed(randomSeed())}>🎲</button>
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
          <button className="primary" disabled={disabled}>Create room</button>
        </form>

        <form className="row" onSubmit={submit(() => join(code))}>
          <input
            id="code-input"
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            maxLength={5}
            placeholder="Room code"
            autoComplete="off"
          />
          <button disabled={disabled}>Join</button>
        </form>

        <p className="error">{error}</p>

        <button type="button" className="settings-link" onClick={() => setSettingsOpen(true)}>
          ⚙ Mouse &amp; key settings
        </button>

        <h2>Open rooms</h2>
        <ul id="room-list">
          {!isConfigured ? (
            <li className="empty">Not connected to Firebase</li>
          ) : rooms === null ? (
            <li className="empty">Loading…</li>
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
                <button disabled={busy} onClick={() => void join(room.code)}>Join</button>
              </li>
            ))
          )}
        </ul>
        <p className="legal muted"><a href="/terms.html" target="_blank" rel="noreferrer">Terms</a> · <a href="/privacy.html" target="_blank" rel="noreferrer">Privacy</a></p>
      </div>
      {settingsOpen && <SettingsPanel onClose={() => setSettingsOpen(false)} />}
    </section>
  );
}
