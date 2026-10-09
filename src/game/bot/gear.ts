import { Inventory } from '../abilities';
import { GUNS, isPickupGun, maxReserve } from '../gunStats';
import type { AbilityType, GunKind, PickupType } from '../../types';

/*
 * What a bot carries besides the rifle: a picked-up gun with its ammo, three ability slots, and the
 * buffs those abilities give. Pure bookkeeping (no network, no scene): the bot host decides when to
 * pick things up and use them.
 */

export interface SpecialGun {
  kind: GunKind;
  mag: number;
  reserve: number;
}

/** Rules that decide what's worth picking up */
export interface PickupRules {
  standard: boolean;
  guns: boolean;
  abilities: boolean;
  ammo: boolean;
}

export class Gear {
  readonly inventory = new Inventory();
  special: SpecialGun | null = null;
  shieldHp = 0;
  /** Buff end times on the bot host's clock (s) */
  shieldUntil = 0;
  speedUntil = 0;
  lifestealUntil = 0;
  cloakUntil = 0;
  blindUntil = 0;
  /** Seconds until the next fire damage check */
  fireTick = 0;
  /** Counts up per throw (others play the throw animation) */
  throws = 0;
  /** A pickup claim in flight */
  claiming = false;
  /** A pickup just dropped: not taken straight back */
  ignore: string | null = null;
  /** No ability before this (s): one at a time, like a person pressing keys */
  nextAbility = 0;

  /** Back to just the rifle, nothing in the slots, no buffs. */
  reset(): void {
    this.inventory.clear();
    this.special = null;
    this.shieldHp = 0;
    this.shieldUntil = this.speedUntil = this.lifestealUntil = this.cloakUntil = this.blindUntil = 0;
    this.fireTick = 0;
    this.ignore = null;
    this.nextAbility = 0;
  }

  /** Whether picking `type` up would do anything for us */
  wants(type: PickupType, rules: PickupRules): boolean {
    if (type === 'ammo') return rules.ammo && !!this.special && this.special.reserve < maxReserve(this.special.kind);
    if (isPickupGun(type)) {
      if (!rules.standard || !rules.guns) return false;
      // A gun we don't have yet, or more rounds for the one we have.
      return !this.special || (this.special.kind === type && this.special.reserve < maxReserve(type));
    }
    return rules.abilities && this.inventory.hasRoom;
  }

  /** Take a claimed pickup. Returns what's left over to put back on the floor (an ability with no room). */
  take(type: PickupType, uses: number | undefined): AbilityType | null {
    if (type === 'ammo') {
      // An ammo box: one more magazine for the picked-up gun (the rifle never runs dry for bots).
      if (this.special) this.special.reserve = Math.min(this.special.reserve + GUNS[this.special.kind].mag, maxReserve(this.special.kind));
      return null;
    }
    if (isPickupGun(type)) {
      const def = GUNS[type];
      const rounds = uses ?? def.mag + def.reserve;
      if (this.special?.kind === type) {
        this.special.reserve = Math.min(this.special.reserve + rounds, maxReserve(type));
      } else {
        const mag = Math.min(def.mag, rounds);
        this.special = { kind: type, mag, reserve: rounds - mag };
      }
      return null;
    }
    return this.inventory.add(type, uses) >= 0 ? null : type;
  }

  /** The first slot holding `type` that's ready, or -1 */
  ready(type: AbilityType, nowMs: number): number {
    const view = this.inventory.view(nowMs);
    for (let i = 0; i < view.length; i++) {
      const slot = view[i];
      if (slot?.type === type && this.inventory.check(i, nowMs).ok) return i;
    }
    return -1;
  }

  /** Spend one use of slot `i` (its cooldown starts). */
  use(i: number, nowMs: number): void {
    this.inventory.consume(i, nowMs);
  }

  has(type: AbilityType): boolean {
    return this.inventory.view(0).some((s) => s?.type === type);
  }

  /** Everything to drop on death: the picked-up gun (with its rounds) and every ability (with its uses) */
  dropAll(): { type: PickupType; uses: number }[] {
    const items: { type: PickupType; uses: number }[] = [];
    if (this.special) {
      const rounds = this.special.mag + this.special.reserve;
      if (rounds > 0 && isPickupGun(this.special.kind)) items.push({ type: this.special.kind, uses: rounds });
    }
    for (const a of this.inventory.takeAll()) items.push({ type: a.type, uses: a.usesLeft });
    this.special = null;
    return items;
  }
}
