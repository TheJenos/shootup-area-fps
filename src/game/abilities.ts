import type { AbilityType } from '../types';

export interface AbilityDef {
  name: string;
  icon: string;
  /** Uses before the ability removes itself from the slot */
  uses: number;
  /** Seconds between uses */
  cooldown: number;
  /** Pickup color on the map */
  color: number;
  description: string;
}

export const ABILITIES: Record<AbilityType, AbilityDef> = {
  medkit: { name: 'Medkit', icon: '🩹', uses: 2, cooldown: 8, color: 0x3ddc84, description: '+50 health' },
  shield: { name: 'Shield', icon: '🛡️', uses: 2, cooldown: 15, color: 0x4aa8ff, description: 'Absorbs 50 damage for 8s' },
  speed: { name: 'Speed Boost', icon: '⚡', uses: 3, cooldown: 12, color: 0xffd23f, description: '1.6× speed for 5s' },
  dash: { name: 'Dash', icon: '💨', uses: 4, cooldown: 3, color: 0x3ff0ff, description: 'Burst forward' },
  grenade: { name: 'Grenade', icon: '💣', uses: 3, cooldown: 6, color: 0xff6a3d, description: 'Area damage, walls block it' },
  smoke: { name: 'Smoke', icon: '🌫️', uses: 2, cooldown: 10, color: 0xc9d1dc, description: 'Thick cloud for 12s, blocks sight' },
  wall: { name: 'Barrier', icon: '🧱', uses: 2, cooldown: 14, color: 0x6fa8ff, description: 'Deployable cover for 20s' },
  cloak: { name: 'Cloak', icon: '👻', uses: 2, cooldown: 18, color: 0xb48cff, description: 'Nearly invisible for 6s; shooting ends it' },
  scan: { name: 'Scan Pulse', icon: '📡', uses: 2, cooldown: 15, color: 0x3fe0c8, description: 'Shows enemies within 32 m through walls for 3.5s' },
  molotov: { name: 'Molotov', icon: '🔥', uses: 2, cooldown: 12, color: 0xff8a2a, description: 'A patch of fire for 6s that burns enemies in it' },
  flash: { name: 'Flashbang', icon: '🔆', uses: 2, cooldown: 12, color: 0xfff3b0, description: 'Blinds everyone looking at it, you too' },
  turret: { name: 'Turret', icon: '🤖', uses: 1, cooldown: 25, color: 0x9aa6b8, description: 'Shoots the nearest enemy in sight for 15s' },
  mine: { name: 'Land Mine', icon: '💥', uses: 2, cooldown: 12, color: 0x8a7a4a, description: 'Blows up when an enemy steps near it' },
  lifesteal: { name: 'Lifesteal', icon: '🩸', uses: 2, cooldown: 20, color: 0xd03a4a, description: 'Your bullets heal you 30% of their damage for 8s' },
};

export const ABILITY_TYPES = Object.keys(ABILITIES) as AbilityType[];
export const SLOT_COUNT = 3;

// Tuning for the effects themselves
export const MEDKIT_HEAL = 50;
export const SHIELD_AMOUNT = 50;
export const SHIELD_DURATION = 8;
export const SPEED_MULTIPLIER = 1.6;
export const SPEED_DURATION = 5;
export const DASH_SPEED = 20;
export const CLOAK_DURATION = 6;
export const SCAN_RADIUS = 32;
export const SCAN_DURATION = 3.5;
export const FIRE_RADIUS = 3.2;
export const FIRE_DURATION = 6;
/** Damage per tick to anyone standing in enemy fire, and seconds between ticks */
export const FIRE_DAMAGE = 8;
export const FIRE_TICK = 0.5;
/** How far a flashbang can blind you, and the longest it lasts (s) */
export const FLASH_RANGE = 24;
export const FLASH_MAX = 3.2;
export const TURRET_DURATION = 15;
export const TURRET_RANGE = 24;
export const TURRET_DAMAGE = 8;
export const TURRET_INTERVAL = 0.4;
/** Damage a turret takes before it's destroyed (about 8 rifle hits) */
export const TURRET_HP = 150;
export const LIFESTEAL_DURATION = 8;
export const LIFESTEAL_FRACTION = 0.3;
export const MINE_ARM = 1.5;
export const MINE_DURATION = 90;
export const MINE_TRIGGER = 1.6;
export const MINE_DAMAGE = 120;
export const MINE_RADIUS = 4;
/** Most of each player's mines out at once; placing another clears the oldest */
export const MINE_MAX = 2;
export const GRENADE_DAMAGE = 90;
export const GRENADE_RADIUS = 5;

interface Slot {
  type: AbilityType;
  usesLeft: number;
  /** performance.now() timestamp when it can be used again */
  readyAt: number;
}

/** What the HUD needs to draw one slot. */
export interface SlotView {
  type: AbilityType;
  usesLeft: number;
  /** Seconds until ready, rounded to 0.1 (0 when ready) */
  cooldown: number;
}

export type UseResult = { ok: true; type: AbilityType } | { ok: false; reason: 'empty' | 'cooldown' };

/** The player's three ability slots. */
export class Inventory {
  private slots: (Slot | null)[] = new Array<Slot | null>(SLOT_COUNT).fill(null);

  get hasRoom(): boolean {
    return this.slots.includes(null);
  }

  /** Puts an ability in the first empty slot; returns its index or -1 when full. */
  add(type: AbilityType, uses = ABILITIES[type].uses): number {
    const i = this.slots.indexOf(null);
    const usesLeft = Math.min(Math.max(1, Math.floor(uses)), ABILITIES[type].uses);
    if (i >= 0) this.slots[i] = { type, usesLeft, readyAt: 0 };
    return i;
  }

  /** Takes the ability out of slot `i` (to drop it on the map). */
  remove(i: number): { type: AbilityType; usesLeft: number } | null {
    const slot = this.slots[i];
    if (!slot) return null;
    this.slots[i] = null;
    return { type: slot.type, usesLeft: slot.usesLeft };
  }

  /** Checks whether slot `i` can fire now, without consuming it. */
  check(i: number, now: number): UseResult {
    const slot = this.slots[i];
    if (!slot) return { ok: false, reason: 'empty' };
    if (now < slot.readyAt) return { ok: false, reason: 'cooldown' };
    return { ok: true, type: slot.type };
  }

  /** Spends one use and starts the cooldown. Returns true when that was the last use and the slot emptied itself. */
  consume(i: number, now: number): boolean {
    const slot = this.slots[i];
    if (!slot) return false;
    slot.usesLeft--;
    slot.readyAt = now + ABILITIES[slot.type].cooldown * 1000;
    if (slot.usesLeft > 0) return false;
    this.slots[i] = null;
    return true;
  }

  clear(): void {
    this.slots.fill(null);
  }

  /** Empties every slot and returns what was in them (to drop on death). */
  takeAll(): { type: AbilityType; usesLeft: number }[] {
    const items = this.slots.flatMap((s) => (s ? [{ type: s.type, usesLeft: s.usesLeft }] : []));
    this.clear();
    return items;
  }

  view(now: number): (SlotView | null)[] {
    return this.slots.map((s) =>
      s && {
        type: s.type,
        usesLeft: s.usesLeft,
        cooldown: Math.max(0, Math.ceil((s.readyAt - now) / 100) / 10),
      },
    );
  }
}
