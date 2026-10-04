import {
  ref, set, get, update, remove, push, onValue, onChildAdded, onChildChanged,
  onChildRemoved, onDisconnect, query, orderByKey, startAt, serverTimestamp,
  runTransaction, type DatabaseReference, type Unsubscribe,
} from 'firebase/database';
import { db } from './firebase';
import { isGameMode } from '../game/modes';
import { CLASSIC_SEED, normalizeSeed } from '../game/mapgen';
import type {
  GameEvent, GameMode, GameRecord, GameState, LobbyRecord, OutgoingEvent, PickupRecord, PlayerState, RoomSummary,
} from '../types';

/*
 * Database layout
 *
 *   lobby/{code}                 { name, mode, seed, host, createdAt, members: { pid: name } }
 *   rooms/{code}/players/{pid}   { name, color, team, x, y, z, yaw, pitch, hp, alive, kills, deaths }
 *   rooms/{code}/game            { round, ended, score, flags }  round state, only changed by transaction
 *   rooms/{code}/events/{eid}    { type: 'shot' | 'kill' | 'grenade' | 'blast', ... }  (auto-removed after a few seconds)
 *   rooms/{code}/pickups/{id}    { type, x, z }  abilities on the map; spawned by one player, claimed by transaction
 *
 * The game is client-authoritative: the shooter decides what they hit, and the
 * victim applies the damage to itself and reports its own death.
 */

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const EVENT_TTL = 3_000;

export function randomId(len = 12): string {
  let s = '';
  for (let i = 0; i < len; i++) s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return s;
}

export function watchRooms(callback: (rooms: RoomSummary[]) => void): Unsubscribe {
  return onValue(ref(db(), 'lobby'), (snap) => {
    const rooms: RoomSummary[] = [];
    snap.forEach((child) => {
      const room = child.val() as LobbyRecord;
      const code = child.key;
      const members = Object.values(room.members || {});
      if (members.length === 0) {
        // Rooms are created with their first member, so an empty room is always abandoned.
        deleteRoom(code);
        return;
      }
      rooms.push({ code, name: room.name, ...roomSetup(room), host: room.host, players: members });
    });
    callback(rooms);
  });
}

export async function createRoom(
  name: string, mode: GameMode, seed: string, host: string, playerId: string,
): Promise<string> {
  let code: string;
  do {
    code = randomId(5);
  } while ((await get(ref(db(), `lobby/${code}`))).exists());
  await set(ref(db(), `lobby/${code}`), {
    name,
    mode,
    seed,
    host,
    createdAt: serverTimestamp(),
    members: { [playerId]: host },
  });
  return code;
}

/** Mode and map seed of an existing room, or null if there's no such room. */
export async function getRoomSetup(code: string): Promise<{ mode: GameMode; seed: string } | null> {
  const room = (await get(ref(db(), `lobby/${code}`))).val() as LobbyRecord | null;
  return room ? roomSetup(room) : null;
}

function roomSetup(room: LobbyRecord): { mode: GameMode; seed: string } {
  return {
    mode: isGameMode(room.mode) ? room.mode : 'ffa',
    seed: (typeof room.seed === 'string' && normalizeSeed(room.seed)) || CLASSIC_SEED,
  };
}

function deleteRoom(code: string) {
  return Promise.all([remove(ref(db(), `lobby/${code}`)), remove(ref(db(), `rooms/${code}`))]);
}

export interface RoomHandlers {
  onPlayerAdded(id: string, data: PlayerState): void;
  onPlayerChanged(id: string, data: PlayerState): void;
  onPlayerRemoved(id: string): void;
  onEvent(event: GameEvent): void;
  onPickupAdded(id: string, pickup: PickupRecord): void;
  onPickupRemoved(id: string): void;
  onGame(game: GameState): void;
}

export class RoomConnection {
  readonly code: string;
  readonly playerId: string;
  private readonly handlers: RoomHandlers;
  private readonly lobbyRef: DatabaseReference;
  private readonly roomRef: DatabaseReference;
  private readonly playerRef: DatabaseReference;
  private readonly memberRef: DatabaseReference;
  private readonly eventsRef: DatabaseReference;
  private readonly pickupsRef: DatabaseReference;
  private readonly gameRef: DatabaseReference;
  private lastOneHere = false;
  private unsubs: Unsubscribe[] = [];
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private getFullState: () => PlayerState = () => {
    throw new Error('join() has not been called');
  };

  constructor(code: string, playerId: string, handlers: RoomHandlers) {
    this.code = code;
    this.playerId = playerId;
    this.handlers = handlers;
    this.lobbyRef = ref(db(), `lobby/${code}`);
    this.roomRef = ref(db(), `rooms/${code}`);
    this.playerRef = ref(db(), `rooms/${code}/players/${playerId}`);
    this.memberRef = ref(db(), `lobby/${code}/members/${playerId}`);
    this.eventsRef = ref(db(), `rooms/${code}/events`);
    this.pickupsRef = ref(db(), `rooms/${code}/pickups`);
    this.gameRef = ref(db(), `rooms/${code}/game`);
  }

  /** @param getFullState returns the complete player record */
  async join(getFullState: () => PlayerState): Promise<void> {
    this.getFullState = getFullState;

    // Re-register presence every time the connection (re)establishes, because
    // onDisconnect handlers fire server-side when the socket drops.
    let first = true;
    await new Promise<void>((resolve, reject) => {
      this.unsubs.push(
        onValue(ref(db(), '.info/connected'), async (snap) => {
          if (!snap.val()) return;
          try {
            await this.registerPresence();
            if (first) { first = false; resolve(); }
          } catch (err) {
            if (first) reject(err);
          }
        }),
      );
    });

    // Whoever is alone in the room arranges for the whole room to be deleted
    // server-side when they disconnect, so closing the tab still cleans up.
    this.unsubs.push(
      onValue(ref(db(), `lobby/${this.code}/members`), (snap) => {
        const members = (snap.val() || {}) as Record<string, string>;
        const alone = Object.keys(members).every((id) => id === this.playerId);
        if (alone !== this.lastOneHere) {
          this.lastOneHere = alone;
          this.armDisconnect().catch((err) => console.warn('onDisconnect update failed', err));
        }
      }),
    );

    const playersRef = ref(db(), `rooms/${this.code}/players`);
    const { onPlayerAdded, onPlayerChanged, onPlayerRemoved, onEvent, onPickupAdded, onPickupRemoved, onGame } = this.handlers;
    this.unsubs.push(
      onChildAdded(playersRef, (s) => s.key && onPlayerAdded(s.key, s.val() as PlayerState)),
      onChildChanged(playersRef, (s) => s.key && onPlayerChanged(s.key, s.val() as PlayerState)),
      onChildRemoved(playersRef, (s) => s.key && onPlayerRemoved(s.key)),
      onChildAdded(this.pickupsRef, (s) => s.key && onPickupAdded(s.key, s.val() as PickupRecord)),
      onChildRemoved(this.pickupsRef, (s) => s.key && onPickupRemoved(s.key)),
      onValue(this.gameRef, (s) => onGame(normalizeGame(s.val()))),
    );

    // Push keys are time-ordered, so starting at a freshly generated key skips
    // events that happened before we joined.
    const fromNow = query(this.eventsRef, orderByKey(), startAt(push(this.eventsRef).key));
    this.unsubs.push(onChildAdded(fromNow, (s) => onEvent(s.val() as GameEvent)));
  }

  private async registerPresence(): Promise<void> {
    const state = this.getFullState();
    await this.armDisconnect();
    await set(this.playerRef, state);
    await set(this.memberRef, state.name);
  }

  /** Queue what the server should delete if we drop: just us, or the whole room if we're the last one. */
  private async armDisconnect(): Promise<void> {
    // cancel() on a parent also clears handlers queued on its children.
    await Promise.all([onDisconnect(this.lobbyRef).cancel(), onDisconnect(this.roomRef).cancel()]);
    if (this.lastOneHere) {
      await Promise.all([onDisconnect(this.lobbyRef).remove(), onDisconnect(this.roomRef).remove()]);
    } else {
      await Promise.all([onDisconnect(this.playerRef).remove(), onDisconnect(this.memberRef).remove()]);
    }
  }

  /** Partial update of our own player record (position, hp, ...). */
  sendState(partial: Partial<PlayerState>): Promise<void> {
    return update(this.playerRef, partial);
  }

  sendEvent(event: OutgoingEvent): void {
    const eventRef = push(this.eventsRef);
    set(eventRef, { ...event, from: this.playerId, t: serverTimestamp() });
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      remove(eventRef);
    }, EVENT_TTL);
    this.timers.add(timer);
  }

  /** Puts an ability on the map; returns its id right away (the write finishes in the background). */
  spawnPickup(pickup: PickupRecord): string | null {
    const pickupRef = push(this.pickupsRef);
    set(pickupRef, pickup).catch((err: unknown) => console.warn('Failed to place pickup', err));
    return pickupRef.key;
  }

  /** Room name, mode and creation time. */
  async roomInfo(): Promise<{ name: string; mode: GameMode; createdAt: number } | null> {
    const snap = await get(this.lobbyRef);
    const room = snap.val() as LobbyRecord | null;
    return room ? { name: room.name, mode: isGameMode(room.mode) ? room.mode : 'ffa', createdAt: room.createdAt } : null;
  }

  /** Everyone currently in the room (used to balance teams before we join). */
  async players(): Promise<Record<string, PlayerState>> {
    return ((await get(ref(db(), `rooms/${this.code}/players`))).val() || {}) as Record<string, PlayerState>;
  }

  /**
   * Atomically change the round state. `change` edits the record in place and
   * returns false to leave it alone; it may run several times if others write at once.
   * Resolves to whether our change was applied.
   */
  async mutateGame(change: (game: GameState) => boolean): Promise<boolean> {
    const result = await runTransaction(this.gameRef, (current: GameRecord | null) => {
      const game = normalizeGame(current);
      return change(game) ? game : undefined;
    }, { applyLocally: false });
    return result.committed;
  }

  /**
   * Try to take a pickup. A transaction guarantees exactly one player gets it
   * even if several touch it at the same moment.
   */
  async claimPickup(id: string): Promise<PickupRecord | null> {
    let claimed: PickupRecord | null = null;
    const result = await runTransaction(ref(db(), `rooms/${this.code}/pickups/${id}`), (current: PickupRecord | null) => {
      if (!current) return undefined; // already gone: abort
      claimed = current;
      return null; // delete it
    }, { applyLocally: false });
    return result.committed ? claimed : null;
  }

  /**
   * Credit a kill to another player and resolve to their new total.
   * Transaction so it never resurrects a player who left.
   */
  async creditKill(killerId: string): Promise<number | null> {
    const result = await runTransaction(ref(db(), `rooms/${this.code}/players/${killerId}`), (player: PlayerState | null) => {
      if (player) player.kills = (player.kills || 0) + 1;
      return player;
    });
    const player = result.snapshot.val() as PlayerState | null;
    return result.committed && player ? player.kills : null;
  }

  async leave(): Promise<void> {
    this.unsubs.forEach((u) => u());
    this.unsubs = [];
    this.timers.forEach(clearTimeout);
    this.timers.clear();
    await Promise.all([onDisconnect(this.lobbyRef).cancel(), onDisconnect(this.roomRef).cancel()]);
    await Promise.all([remove(this.playerRef), remove(this.memberRef)]);
    const members = await get(ref(db(), `lobby/${this.code}/members`));
    if (!members.exists()) await deleteRoom(this.code);
  }
}

/** Fill in the parts Firebase leaves out, since it never stores empty objects. */
function normalizeGame(value: unknown): GameState {
  const game = (value && typeof value === 'object' ? value : {}) as Partial<GameRecord>;
  return { ...game, round: Number(game.round) || 0, score: { ...game.score }, flags: { ...game.flags } };
}
