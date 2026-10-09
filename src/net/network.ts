import {
  ref, set, get, update, remove, push, onValue, onChildAdded, onChildChanged,
  onChildRemoved, onDisconnect, query, orderByKey, startAt, serverTimestamp,
  runTransaction, type DatabaseReference, type Unsubscribe,
} from 'firebase/database';
import { db } from './firebase';
import { countNet } from '../game/perfStats';
import { rulesOfRoom, type ModeRules } from '../game/rules';
import { toSpec, type MapSpec } from '../game/mapgen';
import { startingRoster, type BotRoster, type BotSlot } from '../game/bot/roster';
import type {
  GameEvent, GameMode, GameRecord, GameState, LobbyRecord, OutgoingEvent, PickupRecord, PlayerState, RoomSummary,
} from '../types';

/*
 * Database layout
 *
 *   lobby/{code}                 { name, mode, rules, seed, size, gen, host, hostId, createdAt, members: { pid: name } }
 *   rooms/{code}/players/{pid}   { name, color, team, x, y, z, yaw, pitch, hp, alive, kills, deaths }
 *   rooms/{code}/game            { round, seed, size, gen, mapHash, rules, ended, score, flags }  round state, only changed by transaction
 *   rooms/{code}/events/{eid}    { type: 'shot' | 'kill' | 'grenade' | 'blast', ... }  (auto-removed after a few seconds)
 *   rooms/{code}/pickups/{id}    { type, x, z }  abilities on the map; spawned by one player, claimed by transaction
 *
 * The game is client-authoritative: the shooter decides what they hit, and the
 * victim applies the damage to itself and reports its own death.
 */

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const EVENT_TTL = 3_000;

/** Bots' player ids start with this (humans' never do: randomId has no lowercase or underscore). */
export const BOT_PREFIX = 'b_';
export const isBotId = (id: string): boolean => id.startsWith(BOT_PREFIX);

export function randomId(len = 12): string {
  let s = '';
  for (let i = 0; i < len; i++) s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return s;
}

/** @param onError the subscription was refused (e.g. rules); the list won't load */
export function watchRooms(callback: (rooms: RoomSummary[]) => void, onError?: (err: Error) => void): Unsubscribe {
  return onValue(ref(db(), 'lobby'), (snap) => {
    const rooms: RoomSummary[] = [];
    snap.forEach((child) => {
      const room = child.val() as LobbyRecord;
      const code = child.key;
      const members = Object.values(room.members || {});
      // Bots leave with the player hosting them, so a room of nothing but bots is abandoned too.
      if (Object.keys(room.members || {}).every(isBotId)) {
        // Rooms are created with their first member, so an empty room is always abandoned.
        deleteRoom(code);
        return;
      }
      rooms.push({ code, name: room.name, ...roomSetup(room), host: room.host, players: members });
    });
    callback(rooms);
  }, (err) => onError?.(err));
}

export async function createRoom(
  name: string, rules: ModeRules, map: MapSpec, host: string, playerId: string,
): Promise<string> {
  let code: string;
  do {
    code = randomId(5);
  } while ((await get(ref(db(), `lobby/${code}`))).exists());
  await set(ref(db(), `lobby/${code}`), {
    name,
    mode: rules.base,
    rules,
    ...mapFields(map),
    host,
    hostId: playerId,
    createdAt: serverTimestamp(),
    members: { [playerId]: host },
    ...startingBots(rules),
  });
  // The first round starts now, on the chosen map.
  await set(ref(db(), `rooms/${code}/game`), { round: 0, ...mapFields(map), startedAt: serverTimestamp() });
  return code;
}

/**
 * Create the room `code` unless someone already has it: Discord Activities use a fixed code per
 * voice channel, so two players starting at once must not both create it. Resolves to whether
 * we created it (otherwise just join).
 */
export async function createRoomWithCode(
  code: string, name: string, rules: ModeRules, map: MapSpec, host: string, playerId: string,
): Promise<boolean> {
  const result = await runTransaction(ref(db(), `lobby/${code}`), (current: LobbyRecord | null) => {
    // A record without members is a leftover from an abandoned room: take it over.
    if (current && Object.keys(current.members || {}).length > 0) return undefined;
    return { name, mode: rules.base, rules, ...mapFields(map), host, hostId: playerId, createdAt: Date.now(), members: { [playerId]: host }, ...startingBots(rules) };
  }, { applyLocally: false });
  if (!result.committed) return false;
  await set(ref(db(), `rooms/${code}/game`), { round: 0, ...mapFields(map), startedAt: serverTimestamp() });
  return true;
}

/** A new room's bots, from the "start with bots" setting (Firebase leaves out an empty list) */
function startingBots(rules: ModeRules): { bots?: BotRoster } {
  return rules.bots > 0 ? { bots: startingRoster(rules.bots, rules.botSkill, Date.now()) } : {};
}

/** A map spec as stored on a room */
const mapFields = (map: MapSpec) => ({ seed: map.seed, size: map.size, gen: map.gen });

/**
 * The map spec stored on a room. Rooms from before sizes are medium; rooms from before generator
 * versions were made by version 1.
 */
export const roomMap = (r: { seed?: unknown; size?: unknown; gen?: unknown }): MapSpec =>
  toSpec(typeof r.seed === 'string' ? r.seed : '', r.size, typeof r.gen === 'number' ? r.gen : 1);

/** Mode rules and map of an existing room, or null if there's no such room. */
export async function getRoomSetup(code: string): Promise<{ mode: GameMode; rules: ModeRules; map: MapSpec } | null> {
  const room = (await get(ref(db(), `lobby/${code}`))).val() as LobbyRecord | null;
  return room ? roomSetup(room) : null;
}

function roomSetup(room: LobbyRecord): { mode: GameMode; rules: ModeRules; map: MapSpec } {
  const rules = rulesOfRoom(room.rules, room.mode);
  return { mode: rules.base, rules, map: roomMap(room) };
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
  /** Who owns the room now (see RoomConnection.join) */
  onOwner?(id: string, name: string): void;
  /** The connection to the server came or went */
  onConnection?(connected: boolean): void;
  /** The room's bot list changed (see game/bot/roster.ts) */
  onBotRoster?(roster: BotRoster): void;
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
  /** Bots this client plays for (see game/bot/botHost.ts): their records go when we do */
  private readonly bots = new Map<string, { player: DatabaseReference; member: DatabaseReference }>();
  /** Server clock minus ours, in ms, kept up to date by Firebase */
  private serverOffset = 0;
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
          this.handlers.onConnection?.(!!snap.val());
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
    let members: Record<string, string> = {};
    let hostId: string | null = null;
    // Ownership is only settled once both have loaded: with the members in but the owner not yet, it
    // would look ownerless and the first id would claim it (taking the room's bots with it).
    let membersLoaded = false;
    let hostLoaded = false;
    this.unsubs.push(
      onValue(ref(db(), `lobby/${this.code}/members`), (snap) => {
        members = (snap.val() || {}) as Record<string, string>;
        membersLoaded = true;
        // Bots don't count: a room with only our bots in it goes when we do.
        const alone = Object.keys(members).every((id) => id === this.playerId || isBotId(id));
        if (alone !== this.lastOneHere) {
          this.lastOneHere = alone;
          this.armDisconnect().catch((err) => console.warn('onDisconnect update failed', err));
        }
        if (hostLoaded) this.updateOwner(members, hostId);
      }),
      onValue(ref(db(), `lobby/${this.code}/hostId`), (snap) => {
        hostId = typeof snap.val() === 'string' ? (snap.val() as string) : null;
        hostLoaded = true;
        if (membersLoaded) this.updateOwner(members, hostId);
      }),
    );

    this.unsubs.push(onValue(ref(db(), `lobby/${this.code}/bots`), (snap) => {
      this.handlers.onBotRoster?.((snap.val() || {}) as BotRoster);
    }));

    this.unsubs.push(onValue(ref(db(), '.info/serverTimeOffset'), (snap) => {
      this.serverOffset = Number(snap.val()) || 0;
    }));

    const playersRef = ref(db(), `rooms/${this.code}/players`);
    const { onPlayerAdded, onPlayerChanged, onPlayerRemoved, onEvent, onPickupAdded, onPickupRemoved, onGame } = this.handlers;
    this.unsubs.push(
      onChildAdded(playersRef, (s) => s.key && (countNet('down', s.val()), onPlayerAdded(s.key, s.val() as PlayerState))),
      onChildChanged(playersRef, (s) => s.key && (countNet('down', s.val()), onPlayerChanged(s.key, s.val() as PlayerState))),
      onChildRemoved(playersRef, (s) => s.key && onPlayerRemoved(s.key)),
      onChildAdded(this.pickupsRef, (s) => s.key && onPickupAdded(s.key, s.val() as PickupRecord)),
      onChildRemoved(this.pickupsRef, (s) => s.key && onPickupRemoved(s.key)),
      onValue(this.gameRef, (s) => onGame(normalizeGame(s.val()))),
    );

    // Push keys are time-ordered, so starting at a freshly generated key skips
    // events that happened before we joined.
    const fromNow = query(this.eventsRef, orderByKey(), startAt(push(this.eventsRef).key));
    this.unsubs.push(onChildAdded(fromNow, (s) => (countNet('down', s.val()), onEvent(s.val() as GameEvent))));
  }

  /**
   * The owner is whoever made the room. Once they've left (or in rooms from before owners), the
   * member with the lowest id takes over and records it, so it doesn't move again when someone joins.
   */
  private updateOwner(members: Record<string, string>, hostId: string | null): void {
    // Bots never own a room.
    const ids = Object.keys(members).filter((id) => !isBotId(id));
    if (!ids.length) return;
    if (hostId && members[hostId] !== undefined) {
      this.handlers.onOwner?.(hostId, members[hostId]);
      return;
    }
    const heir = ids.sort()[0]!;
    if (heir === this.playerId) {
      update(this.lobbyRef, { hostId: heir, host: members[heir] })
        .catch((err: unknown) => console.warn('Could not take over the room', err));
    }
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
      // The cancel above cleared our bots' handlers too.
      await Promise.all([...this.bots.values()].flatMap((b) => [onDisconnect(b.player).remove(), onDisconnect(b.member).remove()]));
    }
  }

  // ---------------------------------------------------------------- bots

  /** Put a bot in the room, played by this client; it leaves when we disconnect. */
  async addBot(id: string, state: PlayerState): Promise<void> {
    const refs = { player: ref(db(), `rooms/${this.code}/players/${id}`), member: ref(db(), `lobby/${this.code}/members/${id}`) };
    this.bots.set(id, refs);
    if (!this.lastOneHere) await Promise.all([onDisconnect(refs.player).remove(), onDisconnect(refs.member).remove()]);
    countNet('up', state);
    await set(refs.player, state);
    await set(refs.member, state.name);
    // Removed (or we left) while those writes were on their way: they mustn't leave an orphan behind.
    if (this.bots.get(id) !== refs) await Promise.all([remove(refs.player), remove(refs.member)]);
  }

  async removeBot(id: string): Promise<void> {
    const refs = this.bots.get(id);
    if (!refs) return;
    this.bots.delete(id);
    await Promise.all([onDisconnect(refs.player).cancel(), onDisconnect(refs.member).cancel()]);
    await Promise.all([remove(refs.player), remove(refs.member)]);
  }

  /** Add or change an entry in the room's bot list (the owner's to edit) */
  setBotSlot(id: string, slot: BotSlot): Promise<void> {
    return set(ref(db(), `lobby/${this.code}/bots/${id}`), slot);
  }

  removeBotSlot(id: string): Promise<void> {
    return remove(ref(db(), `lobby/${this.code}/bots/${id}`));
  }

  clearBotSlots(): Promise<void> {
    return remove(ref(db(), `lobby/${this.code}/bots`));
  }

  /** One of our bots got a new name (its level changed): its record and its lobby entry */
  async renameBot(id: string, name: string): Promise<void> {
    const refs = this.bots.get(id);
    if (!refs) return;
    await Promise.all([update(refs.player, { name }), set(refs.member, name)]);
  }

  /** Partial update of one of our bots' records */
  sendStateAs(id: string, partial: { [K in keyof PlayerState]?: PlayerState[K] | null }): Promise<void> {
    const refs = this.bots.get(id);
    if (!refs) return Promise.resolve();
    countNet('up', partial);
    return update(refs.player, partial);
  }

  /** An event from one of our bots */
  sendEventAs(id: string, event: OutgoingEvent): void {
    if (!this.bots.has(id)) return;
    this.pushEvent(event, id);
  }

  /** Partial update of our own player record (position, hp, ...); null removes a field. */
  sendState(partial: { [K in keyof PlayerState]?: PlayerState[K] | null }): Promise<void> {
    countNet('up', partial);
    return update(this.playerRef, partial);
  }

  /**
   * Time a write until the server confirms it: our round trip to Firebase, which every
   * update between players goes through. The write also publishes our last measurement.
   * Resolves to null if there's no answer in time (e.g. offline).
   */
  async measurePing(report: number | null, timeoutMs = 5_000): Promise<number | null> {
    const start = performance.now();
    const ack = update(this.playerRef, { ping: report ?? 0 }).then(() => performance.now() - start);
    const timeout = new Promise<null>((resolve) => {
      const timer = setTimeout(() => {
        this.timers.delete(timer);
        resolve(null);
      }, timeoutMs);
      this.timers.add(timer);
    });
    return Promise.race([ack, timeout]);
  }

  sendEvent(event: OutgoingEvent): void {
    this.pushEvent(event, this.playerId);
  }

  private pushEvent(event: OutgoingEvent, from: string): void {
    const eventRef = push(this.eventsRef);
    countNet('up', event);
    set(eventRef, { ...event, from, t: serverTimestamp() });
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

  /** Our best estimate of the server's clock (ms), so every client agrees on round times. */
  serverNow(): number {
    return Date.now() + this.serverOffset;
  }

  /** Remove every ability lying on the map (a new map has different walls). */
  clearPickups(): Promise<void> {
    return remove(this.pickupsRef);
  }

  /** Keep the lobby list showing the map that's currently being played. */
  setLobbyMap(map: MapSpec): Promise<void> {
    return update(ref(db(), `lobby/${this.code}`), mapFields(map));
  }

  /**
   * The owner's restart: end the round now (no results, nothing ranked) and start a new one with
   * `rules` on `map`. The lobby list follows along.
   */
  async restartMatch(rules: ModeRules, map: MapSpec, now: number): Promise<boolean> {
    const committed = await this.mutateGame((g) => {
      g.round += 1;
      Object.assign(g, mapFields(map));
      g.rules = rules;
      g.startedAt = now;
      delete g.mapHash;
      delete g.ended;
      g.score = {};
      g.flags = {};
      delete g.snd;
      return true;
    });
    if (committed) {
      await Promise.all([
        this.clearPickups(),
        update(this.lobbyRef, { mode: rules.base, rules, ...mapFields(map) }),
      ]);
    }
    return committed;
  }

  /** Room name, mode and creation time. */
  async roomInfo(): Promise<{ name: string; rules: ModeRules; createdAt: number } | null> {
    const snap = await get(this.lobbyRef);
    const room = snap.val() as LobbyRecord | null;
    return room ? { name: room.name, rules: rulesOfRoom(room.rules, room.mode), createdAt: room.createdAt } : null;
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
   * Transaction so it never resurrects a player who left: every player record has `kills` from
   * the moment it's written, so a missing one means the player is gone. Only the kill count is
   * locked, not the whole record, which the killer rewrites many times a second (each of those
   * would make the transaction start over).
   */
  async creditKill(killerId: string): Promise<number | null> {
    const result = await runTransaction(ref(db(), `rooms/${this.code}/players/${killerId}/kills`), (kills: number | null) =>
      kills === null ? undefined : kills + 1);
    const kills = result.snapshot.val() as number | null;
    return result.committed && kills !== null ? kills : null;
  }

  async leave(): Promise<void> {
    this.unsubs.forEach((u) => u());
    this.unsubs = [];
    this.timers.forEach(clearTimeout);
    this.timers.clear();
    // Our bots' records go first, before anything is awaited: cancelling the room's disconnect
    // handlers below also cancels theirs, so they must already be on their way out if the page closes.
    const bots = [...this.bots.values()];
    this.bots.clear();
    const botsGone = Promise.all(bots.flatMap((b) => [remove(b.player), remove(b.member)]));
    await Promise.all([onDisconnect(this.lobbyRef).cancel(), onDisconnect(this.roomRef).cancel()]);
    await Promise.all([remove(this.playerRef), remove(this.memberRef), botsGone]);
    const members = await get(ref(db(), `lobby/${this.code}/members`));
    if (!members.exists()) await deleteRoom(this.code);
  }
}

/** Fill in the parts Firebase leaves out, since it never stores empty objects. */
function normalizeGame(value: unknown): GameState {
  const game = (value && typeof value === 'object' ? value : {}) as Partial<GameRecord>;
  // Firebase leaves empty objects out: an S&D round always has a bomb record, even an empty one.
  const snd = game.snd ? { ...game.snd, bomb: { ...game.snd.bomb } } : undefined;
  return { ...game, round: Number(game.round) || 0, score: { ...game.score }, flags: { ...game.flags }, ...(snd ? { snd } : {}) };
}
