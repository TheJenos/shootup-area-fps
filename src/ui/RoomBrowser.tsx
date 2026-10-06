import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { isConfigured } from '../net/firebase';
import { watchRooms } from '../net/network';
import { GENERATOR_VERSION, SIZE_LABEL, isClassic, isPlayableSpec, mapName, type MapSpec } from '../game/mapgen';
import type { RoomSummary } from '../types';
import { ROOM_CODE_MAX } from './App';

export { mapName };

/** A room's map for the list: its name, and its size unless it's the classic arena */
export const mapLabel = (map: MapSpec): string => (isClassic(map) ? mapName(map.seed) : `${mapName(map.seed)} (${SIZE_LABEL[map.size]})`);

/** Why we can't join a room made by another version of the game */
export const versionMessage = (gen: number): string => (gen > GENERATOR_VERSION
  ? 'That room uses a newer version of the game. Reload to update, then join.'
  : 'That room was made with an older version of the game. Start a new room instead.');

/** How long the room list may stay on "Loading…" before we call it a failure (ms) */
const ROOMS_TIMEOUT_MS = 8_000;

/** Live list of open rooms; `rooms` is `null` while loading. `failed` offers a retry. */
export function useRooms(): { rooms: RoomSummary[] | null; failed: boolean; retry(): void } {
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

interface Props {
  rooms: RoomSummary[] | null;
  failed: boolean;
  retry(): void;
  /** Start code for the code box (an invite link) */
  initialCode?: string;
  /** Something is in progress; `joiningCode` is the room whose button spins */
  busy: boolean;
  joiningCode: string;
  disabled: boolean;
  error: string;
  onJoin(code: string): void;
  onCreate(): void;
  /** Rooms not to list (e.g. the Discord channel's own room, shown on its own tab) */
  hide?: string;
}

/**
 * The open rooms: search them (name, code, mode, map, host, players), join one, type a code,
 * or go create a room. Shared by the lobby and the Discord lobby.
 */
export function RoomBrowser({ rooms, failed, retry, initialCode = '', busy, joiningCode, disabled, error, onJoin, onCreate, hide }: Props) {
  const [search, setSearch] = useState('');
  const [code, setCode] = useState(initialCode);
  const listed = useMemo(() => rooms && (hide ? rooms.filter((r) => r.code !== hide) : rooms), [rooms, hide]);
  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!listed || !q) return listed;
    return listed.filter((r) => [r.name, r.code, r.rules.name, r.rules.short, mapLabel(r.map), r.host, ...r.players]
      .some((field) => field.toLowerCase().includes(q)));
  }, [listed, search]);

  const joinCode = (e: FormEvent) => {
    e.preventDefault();
    if (code.trim()) onJoin(code);
  };

  return (
    <>
      <div className="rooms-toolbar">
        <input
          type="search"
          className="room-search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search rooms, modes, maps, players…"
          aria-label="Search rooms"
        />
        <form className="code-join" onSubmit={joinCode}>
          <input
            id="code-input"
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))}
            maxLength={ROOM_CODE_MAX}
            placeholder="Room code"
            aria-label="Room code"
            autoComplete="off"
          />
          <button disabled={disabled || !code.trim()}>
            {busy && joiningCode === code.trim().toUpperCase() ? <><span className="spinner" aria-hidden="true" />Joining…</> : 'Join'}
          </button>
        </form>
        <button type="button" className="primary" onClick={onCreate}>＋ Create room</button>
      </div>
      <p className="error">{error}</p>
      <ul id="room-list">
        {!isConfigured ? (
          <li className="empty">Not connected to Firebase</li>
        ) : failed ? (
          <li className="empty">Couldn't reach the server <button type="button" onClick={retry}>Retry</button></li>
        ) : shown === null ? (
          <li className="empty"><span className="spinner" aria-hidden="true" />Loading…</li>
        ) : listed && listed.length === 0 ? (
          <li className="empty">
            No open rooms yet.
            <button type="button" className="primary" onClick={onCreate}>Create the first one</button>
          </li>
        ) : shown.length === 0 ? (
          <li className="empty">No rooms match “{search.trim()}”. <button type="button" onClick={() => setSearch('')}>Clear search</button></li>
        ) : (
          shown.map((room) => {
            const playable = isPlayableSpec(room.map);
            return (
            <li key={room.code}>
              <div className="info">
                <div className="name">
                  <span className={`mode-badge ${room.mode}`} title={room.rules.name}>{room.rules.short}</span>
                  {room.name}
                </div>
                <div className="meta">
                  {room.rules.name} · {playable ? mapLabel(room.map) : <span className="version-badge">{room.map.gen > GENERATOR_VERSION ? 'Newer version' : 'Older version'}</span>}
                  {' · '}<span className="code">{room.code}</span> · {room.players.length} playing ·{' '}
                  {room.players.slice(0, 4).join(', ')}{room.players.length > 4 ? '…' : ''}
                </div>
              </div>
              <button
                disabled={disabled || !playable}
                title={playable ? undefined : versionMessage(room.map.gen)}
                onClick={() => onJoin(room.code)}
              >
                {busy && joiningCode === room.code ? <><span className="spinner" aria-hidden="true" />Joining…</> : 'Join'}
              </button>
            </li>
            );
          })
        )}
      </ul>
    </>
  );
}
