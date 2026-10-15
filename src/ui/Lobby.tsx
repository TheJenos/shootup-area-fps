import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { isConfigured } from '../net/firebase';
import { createRoom, getRoomSetup, randomId } from '../net/network';
import { sessionPlayerId } from '../game/session';
import { NAME_PATTERN, loadName, saveName } from './playerName';
import { isPlayableSpec, specForMode } from '../game/mapgen';
import { useMapChoice } from './MapPicker';
import { initAudio } from '../game/audio';
import { enterFullscreen } from '../game/fullscreen';
import { loadCharacter } from '../game/character';
import { loadGunModels } from '../game/guns';
import { loadFpArms } from '../game/fpArms';
import { loadPropModels } from '../game/props';
import { loadPhysics } from '../game/physics';
import { PRESETS, type ModeRules } from '../game/rules';
import type { Session } from './App';
import { CodeJoin, RoomList, RoomSearch, useRooms, versionMessage } from './RoomBrowser';
import { friendlyError } from './errors';
import { Leaderboard } from './Leaderboard';
import { browserProfileId } from '../net/leaderboard';
import { SettingsPanel } from './SettingsPanel';
import { afterLeave } from './GameView';
import { MenuFrame, MenuPanel, MenuRail, ProfileChip, type MenuTab } from './MenuShell';
import { CreateWizard } from './CreateWizard';

type Invite = 'auto' | 'manual' | 'closed' | null;

interface Props {
  initialCode: string;
  initialError: string;
  onEnter(session: Session): void;
}

type View = 'rooms' | 'create' | 'leaderboard';
/** What's under way, and where its error belongs */
type Action = 'quick' | 'code' | 'list' | 'create';

/** Bots in a Quick play room, and in a room created while no other room is open */
const QUICK_PLAY_BOTS = 5;
const LONELY_ROOM_BOTS = 3;

export function Lobby({ initialCode, initialError, onEnter }: Props) {
  /** The player's name: chosen on the first visit, kept in this browser, changeable in Settings */
  const [name, setName] = useState(() => loadName().trim().slice(0, 16));
  const [draftName, setDraftName] = useState('');
  const [nameError, setNameError] = useState('');
  const [view, setView] = useState<View>('rooms');
  const [search, setSearch] = useState('');
  const [roomName, setRoomName] = useState('');
  const [rules, setRules] = useState<ModeRules>(PRESETS[0]!.rules);
  // A blank seed means "surprise me": a fresh random seed is used when the room is created.
  const mapChoice = useMapChoice();
  /** The last thing that went wrong, and which action it belongs to (shown next to it) */
  const [error, setError] = useState<{ at: Action; text: string } | null>(initialError ? { at: 'code', text: initialError } : null);
  /** What we're doing, and which listed room's button should spin */
  const [busy, setBusy] = useState<Action | null>(null);
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
  /** The invite's countdown is running (it starts once the page has settled: see below) */
  const [counting, setCounting] = useState(false);
  useEffect(() => {
    if (invite !== 'auto' || !hasName) return;
    // From the first idle moment, so the two seconds to say "Stay in the lobby" are two seconds the page
    // can actually answer in (not spent loading).
    let timer = 0;
    const begin = () => {
      setCounting(true);
      timer = window.setTimeout(() => { void join(initialCode, 'code'); }, 2000);
    };
    const idle = typeof requestIdleCallback === 'function' ? requestIdleCallback(begin, { timeout: 1500 }) : (begin(), 0);
    return () => {
      clearTimeout(timer);
      if (idle) cancelIdleCallback(idle);
      setCounting(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [invite, hasName]);
  const disabled = !!busy || !isConfigured;
  const errorAt = (at: Action) => (error?.at === at ? error.text : '');

  /** Keep the chosen name in this browser. */
  const chooseName = (e: FormEvent) => {
    e.preventDefault();
    const chosen = draftName.trim().replace(/\s+/g, ' ');
    if (!NAME_PATTERN.test(chosen)) {
      setNameError('Names are 2–16 characters: letters, numbers, spaces, - or _.');
      return;
    }
    saveName(chosen);
    setName(chosen);
    setNameError('');
  };

  /** Runs `action` with the lobby locked. */
  const run = async (kind: Action, action: (playerName: string) => Promise<void>) => {
    if (!hasName || busy) return;
    initAudio();
    // Fullscreen now, while we still have the click (browsers refuse it once the room has loaded).
    enterFullscreen().catch(() => { /* refused (no click, e.g. an invite's countdown): the first click to play retries */ });
    setBusy(kind);
    setError(null);
    try {
      await action(name);
    } catch (err) {
      console.error(err);
      setError({ at: kind, text: friendlyError(err) });
      setBusy(null);
      setJoiningCode('');
      // Didn't get in: back out of fullscreen to read the lobby.
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    }
  };

  const join = (roomCode: string, from: 'code' | 'list') => {
    const normalized = roomCode.trim().toUpperCase();
    setJoiningCode(normalized);
    return run(from, async (playerName) => {
      if (!normalized) throw new Error('Enter a room code.');
      await afterLeave();
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
      // A refreshed tab comes back as the same player (see game/session.ts).
      onEnter({ roomCode: normalized, playerId: sessionPlayerId(normalized, randomId), name: playerName, map: setup.map, profileId });
    });
  };

  const create = () => run('create', async (playerName) => {
    const playerId = randomId();
    const title = roomName.trim().slice(0, 24) || `${playerName}'s room`;
    const map = specForMode(mapChoice.spec(), rules.base);
    const roomCode = await createRoom(title, rules, map, playerName, playerId);
    onEnter({ roomCode, playerId, name: playerName, map, profileId });
  });

  /** Straight into a free-for-all against bots: a match with nobody else online, or a warm-up. */
  const quickPlay = () => run('quick', async (playerName) => {
    const playerId = randomId();
    const practice: ModeRules = { ...PRESETS[0]!.rules, bots: QUICK_PLAY_BOTS, botSkill: 'normal' };
    const map = specForMode(mapChoice.spec(), practice.base);
    const roomCode = await createRoom(`${playerName}'s practice`, practice, map, playerName, playerId);
    onEnter({ roomCode, playerId, name: playerName, map, profileId });
  });

  // Nobody else around: a room made now would be empty, so start it with a few bots unless told otherwise.
  const botsDefaulted = useRef(false);
  useEffect(() => {
    if (botsDefaulted.current || rooms === null) return;
    botsDefaulted.current = true;
    if (rooms.length === 0) setRules((r) => (r.bots === 0 ? { ...r, bots: LONELY_ROOM_BOTS } : r));
  }, [rooms]);

  const backToRooms = useCallback(() => setView('rooms'), []);

  const tabs: MenuTab[] = [
    { id: 'rooms', label: 'Rooms', short: 'Rooms', sub: 'Join a match in progress', icon: '◇', ...(rooms ? { count: rooms.length } : {}) },
    { id: 'create', label: 'Create room', short: 'Create', sub: 'Pick a mode and a map', icon: '＋' },
    { id: 'leaderboard', label: 'Leaderboard', short: 'Ranks', sub: 'The best of everyone', icon: '★' },
  ];

  const alerts = (
    <>
      {!isConfigured && (
        <div className="warning">
          Firebase isn't configured. Copy <code>.env.example</code> to <code>.env</code> and fill in your
          project's web config, or run <code>npm run emulator</code> + <code>npm run dev:emu</code>.
        </div>
      )}
      {hasName && invite === 'auto' ? (
        <div className="invite-card" role="status">
          <p>
            {busy === 'code' ? <span className="spinner" aria-hidden="true" /> : null}
            Joining room <strong>{initialCode}</strong>…
          </p>
          <div className="row">
            <button type="button" className="primary" disabled={disabled} onClick={() => void join(initialCode, 'code')}>Join now</button>
            <button type="button" disabled={disabled} onClick={() => setInvite(null)}>Stay in the lobby</button>
          </div>
          {busy !== 'code' && counting && <div className="progress" aria-hidden="true" />}
        </div>
      ) : hasName && invite === 'closed' ? (
        <div className="warning">That room has closed — create a new one, or ask for a fresh invite.</div>
      ) : null}
    </>
  );

  if (!hasName) {
    // First visit: pick the name once.
    return (
      <MenuFrame>
        <div className="menu-welcome">
          {alerts}
          <form className="name-setup" onSubmit={chooseName}>
            <p className="kicker">Drop in · frag friends · no downloads</p>
            <h2>What should we call you?</h2>
            <p className="muted">
              {initialCode ? <>You've been invited to room <strong>{initialCode}</strong>. </> : null}
              It's how everyone sees you in matches and on the leaderboard. You can change it later in Settings.
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
              <button className="primary" disabled={draftName.trim().length < 2}>Continue ▸</button>
            </div>
            <small className="muted">2–16 characters: letters, numbers, spaces, - or _.</small>
            <p className="error">{nameError}</p>
          </form>
        </div>
      </MenuFrame>
    );
  }

  return (
    <MenuFrame
      profile={<ProfileChip name={name} title="Your name on this browser (change it in Settings)" />}
      onSettings={() => setSettingsOpen(true)}
      // An invite is counting down to joining: nothing heavy until it's done (or cancelled).
      backdropDelay={invite === 'auto' ? 4000 : undefined}
    >
      <div className="menu-alerts">{alerts}</div>
      <MenuRail
        hero={(
          <div className="menu-play-wrap">
            <button type="button" className="menu-play" disabled={disabled} onClick={() => void quickPlay()}>
              <span className="label">{busy === 'quick' ? <><span className="spinner" aria-hidden="true" />Starting…</> : <>▶ Play now</>}</span>
              <span className="sub">Free-for-all against bots — straight in</span>
            </button>
            {errorAt('quick') && <p className="error" role="alert">{errorAt('quick')}</p>}
          </div>
        )}
        tabs={tabs}
        active={view}
        onSelect={(id) => setView(id as View)}
        extra={(
          <CodeJoin
            // A closed invite's code shouldn't linger in the code box.
            key={invite === 'closed' ? 'closed' : 'open'}
            initialCode={invite === 'closed' ? '' : initialCode}
            busy={busy === 'code'}
            joiningCode={joiningCode}
            disabled={disabled}
            error={errorAt('code')}
            onJoin={(c) => void join(c, 'code')}
          />
        )}
      />

      {view === 'rooms' && (
        <MenuPanel
          id="rooms"
          title={<>Open rooms {rooms && <span className="live"><span className="dot" aria-hidden="true" />{rooms.length} live</span>}</>}
          aside={<RoomSearch value={search} onChange={setSearch} />}
        >
          {errorAt('list') && <p className="error" role="alert">{errorAt('list')}</p>}
          <RoomList
            rooms={rooms}
            failed={roomsFailed}
            retry={retryRooms}
            search={search}
            onClearSearch={() => setSearch('')}
            busy={busy === 'list'}
            joiningCode={joiningCode}
            disabled={disabled}
            onJoin={(c) => void join(c, 'list')}
            onCreate={() => setView('create')}
            onQuickPlay={() => void quickPlay()}
          />
        </MenuPanel>
      )}

      {view === 'create' && (
        <MenuPanel id="create" title="Create a room">
          <CreateWizard
            rules={rules}
            onRules={setRules}
            mapChoice={mapChoice}
            roomFields={(
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
            )}
            launchLabel={`Create ${rules.name} room`}
            busyLabel="Creating…"
            busy={busy === 'create'}
            disabled={disabled}
            onLaunch={() => void create()}
            error={errorAt('create')}
            note="You'll get a code to share once you're in."
            onExit={backToRooms}
          />
        </MenuPanel>
      )}

      {view === 'leaderboard' && (
        <MenuPanel id="leaderboard">
          <Leaderboard limit={20} me={profileId} />
        </MenuPanel>
      )}

      {settingsOpen && (
        <SettingsPanel
          onClose={() => setSettingsOpen(false)}
          profile={{ name, onRename: (n) => { saveName(n); setName(n); } }}
        />
      )}
    </MenuFrame>
  );
}
