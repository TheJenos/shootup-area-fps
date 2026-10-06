import { useEffect, useState, type FormEvent } from 'react';
import { isConfigured } from '../net/firebase';
import { createRoom, getRoomSetup, randomId } from '../net/network';
import { isPlayableSpec } from '../game/mapgen';
import { MapPicker, useMapChoice } from './MapPicker';
import { initAudio } from '../game/audio';
import { enterFullscreen } from '../game/fullscreen';
import { loadCharacter } from '../game/character';
import { loadGunModels } from '../game/guns';
import { loadFpArms } from '../game/fpArms';
import { loadPropModels } from '../game/props';
import { loadPhysics } from '../game/physics';
import { ModePicker } from './ModePicker';
import { PRESETS, type ModeRules } from '../game/rules';
import type { Session } from './App';
import { RoomBrowser, useRooms, versionMessage } from './RoomBrowser';
import { Brand } from './Brand';
import { friendlyError } from './errors';
import { Leaderboard } from './Leaderboard';
import { browserProfileId } from '../net/leaderboard';
import { SettingsPanel } from './SettingsPanel';

const NAME_KEY = 'fps-name';

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

type Invite = 'auto' | 'manual' | 'closed' | null;

interface Props {
  initialCode: string;
  initialError: string;
  onEnter(session: Session): void;
}

type Tab = 'rooms' | 'create' | 'leaderboard';

/** Names are 2–16 letters, digits, spaces, - or _ (no leading / trailing spaces). */
const NAME_PATTERN = /^[\p{L}\p{N} _-]{2,16}$/u;

export function Lobby({ initialCode, initialError, onEnter }: Props) {
  /** The player's name: chosen once, then kept in this browser and not changed again */
  const [name, setName] = useState(() => loadName().trim().slice(0, 16));
  const [draftName, setDraftName] = useState('');
  const [tab, setTab] = useState<Tab>('rooms');
  const [roomName, setRoomName] = useState('');
  const [rules, setRules] = useState<ModeRules>(PRESETS[0]!.rules);
  // A blank seed means "surprise me": a fresh random seed is used when the room is created.
  const mapChoice = useMapChoice();
  const [error, setError] = useState(initialError);
  /** What we're doing, and which listed room's button should spin */
  const [busy, setBusy] = useState<'join' | 'create' | null>(null);
  const [joiningCode, setJoiningCode] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const { rooms, failed: roomsFailed, retry: retryRooms } = useRooms();
  const [profileId] = useState(browserProfileId);
  // Start downloading the player and gun models while the user is still in the lobby.
  useEffect(() => {
    loadCharacter().catch(() => {});
    loadGunModels().catch(() => {});
    loadFpArms().catch(() => {});
    loadPropModels().catch(() => {});
    // The physics engine too (its own ~1.7 MB download; the game can't start without it).
    loadPhysics().catch(() => {});
  }, []);
  // Opened from an invite link: once there's a name, a short countdown then straight in.
  const [invite, setInvite] = useState<Invite>(() => (initialCode && isConfigured && !initialError ? 'auto' : null));
  const hasName = name.length > 0;
  useEffect(() => {
    if (invite !== 'auto' || !hasName) return;
    const timer = setTimeout(() => { void join(initialCode); }, 2000);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [invite, hasName]);
  const disabled = !!busy || !isConfigured;

  /** Keep the chosen name for good. */
  const chooseName = (e: FormEvent) => {
    e.preventDefault();
    const chosen = draftName.trim().replace(/\s+/g, ' ');
    if (!NAME_PATTERN.test(chosen)) {
      setError('Names are 2–16 characters: letters, numbers, spaces, - or _.');
      return;
    }
    saveName(chosen);
    setName(chosen);
    setError('');
  };

  /** Runs `action` with the lobby locked. */
  const run = async (kind: 'join' | 'create', action: (playerName: string) => Promise<void>) => {
    if (!hasName || busy) return;
    initAudio();
    // Fullscreen now, while we still have the click (browsers refuse it once the room has loaded).
    enterFullscreen().catch(() => { /* refused (no click, e.g. an invite's countdown): the first click to play retries */ });
    setBusy(kind);
    setError('');
    try {
      await action(name);
    } catch (err) {
      console.error(err);
      setError(friendlyError(err));
      setBusy(null);
      setJoiningCode('');
      // Didn't get in: back out of fullscreen to read the lobby.
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
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
          history.replaceState(null, '', location.pathname);
        }
        throw new Error(`Room ${normalized} doesn't exist.`);
      }
      if (!isPlayableSpec(setup.map)) throw new Error(versionMessage(setup.map.gen));
      onEnter({ roomCode: normalized, playerId: randomId(), name: playerName, map: setup.map, profileId });
    });
  };

  const create = () => run('create', async (playerName) => {
    const playerId = randomId();
    const title = roomName.trim().slice(0, 24) || `${playerName}'s room`;
    const map = mapChoice.spec();
    const roomCode = await createRoom(title, rules, map, playerName, playerId);
    onEnter({ roomCode, playerId, name: playerName, map, profileId });
  });

  const submit = (action: () => Promise<void>) => (e: FormEvent) => {
    e.preventDefault();
    void action();
  };

  const tabs: { id: Tab; label: string; count?: number }[] = [
    { id: 'rooms', label: 'Open rooms', ...(rooms ? { count: rooms.length } : {}) },
    { id: 'create', label: 'Create room' },
    { id: 'leaderboard', label: 'Leaderboard' },
  ];

  return (
    <section id="lobby" className="screen">
      <div className="card lobby-tabs-card">
        <header className="lobby-top">
          <Brand />
          {hasName && (
            <div className="lobby-profile">
              <span className="muted">Playing as</span>
              <strong title="Your name is set for good on this browser">{name}</strong>
              <button type="button" className="icon-button" aria-label="Mouse and key settings" title="Settings" onClick={() => setSettingsOpen(true)}>⚙</button>
            </div>
          )}
        </header>

        {!isConfigured && (
          <div className="warning">
            Firebase isn't configured. Copy <code>.env.example</code> to <code>.env</code> and fill in your
            project's web config, or run <code>npm run emulator</code> + <code>npm run dev:emu</code>.
          </div>
        )}

        {!hasName ? (
          // First visit: pick the name once.
          <form className="name-setup" onSubmit={chooseName}>
            <h2>Choose your name</h2>
            <p className="muted">
              {initialCode ? <>You've been invited to room <strong>{initialCode}</strong>. </> : null}
              It's how everyone sees you in matches and on the leaderboard. <strong>You can't change it later.</strong>
            </p>
            <div className="row">
              <input
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
                maxLength={16}
                placeholder="e.g. Maverick"
                autoComplete="off"
                autoFocus
                aria-label="Your name"
              />
              <button className="primary" disabled={draftName.trim().length < 2}>Continue</button>
            </div>
            <small className="muted">2–16 characters: letters, numbers, spaces, - or _.</small>
            <p className="error">{error}</p>
          </form>
        ) : (
          <>
            {invite === 'auto' ? (
              <div className="invite-card" role="status">
                <p>
                  {busy === 'join' ? <span className="spinner" aria-hidden="true" /> : null}
                  Joining room <strong>{initialCode}</strong>…
                </p>
                <div className="row">
                  <button type="button" className="primary" disabled={disabled} onClick={() => void join(initialCode)}>Join now</button>
                  <button type="button" disabled={disabled} onClick={() => setInvite(null)}>Stay in the lobby</button>
                </div>
                {busy !== 'join' && <div className="progress" aria-hidden="true" />}
              </div>
            ) : invite === 'closed' ? (
              <div className="warning">That room has closed — create a new one, or ask for a fresh invite.</div>
            ) : null}

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

            {tab === 'rooms' && (
              <section id="panel-rooms" role="tabpanel" aria-labelledby="tab-rooms" className="tab-panel">
                <RoomBrowser
                  // A closed invite's code shouldn't linger in the code box.
                  key={invite === 'closed' ? 'closed' : 'open'}
                  rooms={rooms}
                  failed={roomsFailed}
                  retry={retryRooms}
                  initialCode={invite === 'closed' ? '' : initialCode}
                  busy={busy === 'join'}
                  joiningCode={joiningCode}
                  disabled={disabled}
                  error={error}
                  onJoin={(c) => void join(c)}
                  onCreate={() => setTab('create')}
                />
              </section>
            )}

            {tab === 'create' && (
              <section id="panel-create" role="tabpanel" aria-labelledby="tab-create" className="tab-panel create-panel">
                <div className="create-grid">
                  <div className="field">
                    <span>Game mode</span>
                    <ModePicker value={rules} onChange={setRules} />
                  </div>
                  <div className="create-side">
                    <div className="field">
                      <span>Map</span>
                      <MapPicker choice={mapChoice} mode={rules.base} hint={<>Same seed, same map. <code>classic</code> is the original arena.</>} />
                    </div>
                    <form className="create-form" onSubmit={submit(create)}>
                      <label className="field">
                        <span>Room name</span>
                        <input
                          value={roomName}
                          onChange={(e) => setRoomName(e.target.value)}
                          maxLength={24}
                          placeholder={`${name}'s room`}
                          autoComplete="off"
                        />
                      </label>
                      <button className="primary create-button" disabled={disabled}>
                        {busy === 'create' ? <><span className="spinner" aria-hidden="true" />Creating…</> : `Create ${rules.name} room`}
                      </button>
                      <p className="error">{error}</p>
                    </form>
                  </div>
                </div>
              </section>
            )}

            {tab === 'leaderboard' && (
              <section id="panel-leaderboard" role="tabpanel" aria-labelledby="tab-leaderboard" className="tab-panel">
                <Leaderboard limit={20} me={profileId} />
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
