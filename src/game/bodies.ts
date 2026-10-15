import { BODY_GROUPS, CROUCH_HEIGHT, SKIN, capsuleHalf } from './movement';
import { HEIGHT, RADIUS } from './playerDims';
import type { PhysicsWorld, RapierCollider } from './physics';
import type { Stance } from '../types';

/*
 * Everyone else's bodies in our physics world, so we (and the bots we play) can't walk through
 * them: a capsule per living player, where we draw them and as tall as their stance. Our own body
 * and our bots' are the capsules their movement already moves (movement.ts).
 */

export interface BodyPose {
  id: string;
  x: number;
  y: number;
  z: number;
  stance: Stance;
  /** Alive and playing (the dead and spectators are walked through) */
  solid: boolean;
}

interface Body {
  collider: RapierCollider;
  height: number;
  /** The last sync that listed it */
  seen: number;
}

/** Reused for every setTranslation: this runs every frame */
const _at = { x: 0, y: 0, z: 0 };

export class RemoteBodies {
  private physics: PhysicsWorld | null = null;
  private readonly bodies = new Map<string, Body>();
  private syncs = 0;

  /** Put every listed player's body where they are; bodies of players not listed go. */
  sync(physics: PhysicsWorld | null, players: Iterable<BodyPose>): void {
    if (physics !== this.physics) {
      this.clear();
      this.physics = physics;
    }
    if (!physics || physics.disposed) return;
    const { R, world } = physics;
    const sync = ++this.syncs;
    for (const p of players) {
      const height = p.stance === 'stand' ? HEIGHT : CROUCH_HEIGHT;
      let body = this.bodies.get(p.id);
      if (!body) {
        const collider = world.createCollider(R.ColliderDesc.capsule(capsuleHalf(height), RADIUS).setCollisionGroups(BODY_GROUPS));
        body = { collider, height, seen: sync };
        this.bodies.set(p.id, body);
      } else if (body.height !== height) {
        body.collider.setHalfHeight(capsuleHalf(height));
        body.height = height;
      }
      body.seen = sync;
      if (body.collider.isEnabled() !== p.solid) body.collider.setEnabled(p.solid);
      _at.x = p.x;
      _at.y = p.y + SKIN + height / 2;
      _at.z = p.z;
      body.collider.setTranslation(_at);
    }
    for (const [id, body] of this.bodies) {
      if (body.seen === sync) continue;
      if (body.collider.isValid()) world.removeCollider(body.collider, false);
      this.bodies.delete(id);
    }
  }

  clear(): void {
    const physics = this.physics;
    if (physics && !physics.disposed) {
      for (const body of this.bodies.values()) if (body.collider.isValid()) physics.world.removeCollider(body.collider, false);
    }
    this.bodies.clear();
  }
}
