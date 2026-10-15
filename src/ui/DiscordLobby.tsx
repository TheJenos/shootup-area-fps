import { useEffect, useState } from 'react';
import { connectDiscord, step, type DiscordSession } from '../discord/discord';
import { createRoomWithCode, getRoomSetup, randomId } from '../net/network';
import { sessionPlayerId } from '../game/session';
import { initAudio } from '../game/audio';
import { loadCharacter } from '../game/character';
import { loadGunModels } from '../game/guns';
import { loadFpArms } from '../game/fpArms';
import { loadPropModels } from '../game/props';
import { loadPhysics } from '../game/physics';
import { PRESETS, type ModeRules } from '../game/rules';
import { GENERATOR_VERSION, isPlayableSpec, specForMode, type MapSpec } from '../game/mapgen';
import { useMapChoice } from './MapPicker';
import { CodeJoin, RoomList, RoomSearch, mapLabel, useRooms, versionMessage } from './RoomBrowser';
import type { Session } from './App';
import { MenuFrame, MenuPanel, MenuRail, ProfileChip, type MenuTab } from './MenuShell';
import { CreateWizard } from './CreateWizard';
import { MapThumb } from './MapPreview';
import { friendlyError } from './errors';
import { SettingsPanel } from './SettingsPanel';
import { Leaderboard } from './Leaderboard';
import { discordProfileId } from '../net/leaderboard';
import { afterLeave } from './GameView';

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

type Existing = { rules: ModeRules; map: MapSpec } | null;
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
  const [search, setSearch] = useState('');
  /** Why joining another room (by its code or from the list) didn't work */
  const [joinError, setJoinError] = useState('');
  const mapChoice = useMapChoice();
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
    // The physics engine too (its own ~1.7 MB download; the game can't start without it).
    loadPhysics().catch(() => {});
    connectDiscord()
      .then(async (d) => {
        await afterLeave();
        const setup = await step('loading this channel\'s match from the database', getRoomSetup(roomCodeFor(d.instanceId)));
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
      // A refreshed Activity comes back as the same player (see game/session.ts).
      const playerId = sessionPlayerId(roomCode, randomId);
      await afterLeave();
      // Always try: the match we saw may have ended since (its last player left), and then we
      // start it again as it was. If someone else started one since we looked, we join theirs.
      const created = await createRoomWithCode(
        roomCode, 'Discord match', existing?.rules ?? rules, existing?.map ?? specForMode(mapChoice.spec(), rules.base), discord.name, playerId,
      );
      const setup = await getRoomSetup(roomCode);
      if (!setup) throw new Error('Could not start the match. Try again.');
      if (!isPlayableSpec(setup.map)) throw new Error(versionMessage(setup.map.gen));
      // We lost the race to start: the mode we picked wasn't used.
      const notice = !existing && !created && setup.rules.name !== rules.name
        ? `Someone started first — you joined their ${setup.rules.name} match`
        : undefined;
      onEnter({
        roomCode, playerId, name: discord.name, map: setup.map, profileId: discordProfileId(discord.userId), guildId: discord.guildId, ...(notice ? { notice } : {}),
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
    setJoinError('');
    try {
      await afterLeave();
      const setup = await getRoomSetup(normalized);
      if (!setup) throw new Error(`Room ${normalized} doesn't exist.`);
      if (!isPlayableSpec(setup.map)) throw new Error(versionMessage(setup.map.gen));
      onEnter({ roomCode: normalized, playerId: sessionPlayerId(normalized, randomId), name: discord.name, map: setup.map, profileId: discordProfileId(discord.userId), guildId: discord.guildId });
    } catch (err) {
      console.error(err);
      setJoinError(friendlyError(err));
      setBusy(false);
      setJoiningCode('');
    }
  };

  const others = rooms ? rooms.filter((r) => r.code !== roomCode).length : undefined;
  const tabs: MenuTab[] = [
    { id: 'channel', label: 'This channel', short: 'Channel', sub: existing ? 'A match is running' : 'Start the voice channel\'s match', icon: '◉' },
    { id: 'rooms', label: 'Rooms', short: 'Rooms', sub: 'Other open matches', icon: '◇', ...(others !== undefined ? { count: others } : {}) },
    { id: 'leaderboard', label: 'Leaderboard', short: 'Ranks', sub: 'This server and everyone', icon: '★' },
  ];

  if (!discord) {
    return (
      <MenuFrame discord>
        <div className="menu-welcome">
          <div className="name-setup discord-connect" role="status">
            <h2>{error ? 'Could not connect to Discord' : <><span className="spinner" aria-hidden="true" />Connecting to Discord…</>}</h2>
            {error && (
              <>
                <p className="error">{error}</p>
                <button type="button" className="primary" onClick={() => { setError(''); setAttempt((a) => a + 1); }}>Retry</button>
              </>
            )}
          </div>
        </div>
      </MenuFrame>
    );
  }

  const playable = !existing || isPlayableSpec(existing.map);
  return (
    <MenuFrame discord profile={<ProfileChip name={discord.name} title="Your Discord name" />} onSettings={() => setSettingsOpen(true)}>
      <MenuRail
        hero={(
          <div className="menu-play-wrap">
            <button
              type="button"
              className="menu-play"
              disabled={busy || !playable}
              onClick={() => (existing ? void play() : setTab('channel'))}
            >
              <span className="label">{busy && !joiningCode ? <><span className="spinner" aria-hidden="true" />Joining…</> : existing ? <>▶ Join the match</> : <>▶ Start a match</>}</span>
              <span className="sub">{existing ? `${existing.rules.name} on ${mapLabel(existing.map)}` : 'Everyone in this voice channel plays together'}</span>
            </button>
          </div>
        )}
        tabs={tabs}
        active={tab}
        onSelect={(id) => setTab(id as Tab)}
        extra={(
          <CodeJoin busy={busy} joiningCode={joiningCode} disabled={busy} error={joinError} onJoin={(c) => void joinOther(c)} />
        )}
      />

      {tab === 'channel' && (
        <MenuPanel id="channel" title={existing ? 'This channel\'s match' : 'Start this channel\'s match'}>
          {existing ? (
            // A match is already running in this voice channel: one big way in.
            <div className="channel-match">
              <div className="match-info">
                <MapThumb spec={existing.map} mode={existing.rules.base} size={96} />
                <div>
                  <span className={`mode-badge ${existing.rules.base}`}>{existing.rules.short}</span>
                  <strong>{existing.rules.name}</strong> on <strong>{mapLabel(existing.map)}</strong>
                  <p className="muted">A match is running in this voice channel. Jump in — everyone here plays together.</p>
                </div>
              </div>
              {playable ? (
                <button className="primary create-button" disabled={busy} onClick={() => void play()}>
                  {busy ? <><span className="spinner" aria-hidden="true" />Joining…</> : 'Join match'}
                </button>
              ) : (
                <div className="warning version-notice" role="alert">
                  {versionMessage(existing.map.gen)}
                  {existing.map.gen > GENERATOR_VERSION && <button type="button" className="primary" onClick={() => location.reload()}>Restart</button>}
                </div>
              )}
              <p className="error">{error}</p>
            </div>
          ) : (
            <CreateWizard
              rules={rules}
              onRules={setRules}
              mapChoice={mapChoice}
              launchLabel={`Start ${rules.name}`}
              busyLabel="Starting…"
              busy={busy}
              disabled={busy}
              onLaunch={() => void play()}
              error={error}
              note="Everyone in this voice channel plays in the same match."
              onExit={() => setTab('rooms')}
            />
          )}
        </MenuPanel>
      )}

      {tab === 'rooms' && (
        <MenuPanel id="rooms" title="Other open rooms" aside={<RoomSearch value={search} onChange={setSearch} />}>
          <RoomList
            rooms={rooms}
            failed={roomsFailed}
            retry={retryRooms}
            hide={roomCode}
            search={search}
            onClearSearch={() => setSearch('')}
            busy={busy}
            joiningCode={joiningCode}
            disabled={busy}
            onJoin={(c) => void joinOther(c)}
            onCreate={() => setTab('channel')}
          />
        </MenuPanel>
      )}

      {tab === 'leaderboard' && (
        <MenuPanel id="leaderboard">
          <Leaderboard limit={20} me={discordProfileId(discord.userId)} guildId={discord.guildId} />
        </MenuPanel>
      )}
      {settingsOpen && <SettingsPanel onClose={() => setSettingsOpen(false)} />}
    </MenuFrame>
  );
}
