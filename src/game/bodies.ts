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
}

export class RemoteBodies {
  private physics: PhysicsWorld | null = null;
  private readonly bodies = new Map<string, Body>();

  /** Put every listed player's body where they are; bodies of players not listed go. */
  sync(physics: PhysicsWorld | null, players: Iterable<BodyPose>): void {
    if (physics !== this.physics) {
      this.clear();
      this.physics = physics;
    }
    if (!physics || physics.disposed) return;
    const { R, world } = physics;
    const seen = new Set<string>();
    for (const p of players) {
      seen.add(p.id);
      const height = p.stance === 'stand' ? HEIGHT : CROUCH_HEIGHT;
      let body = this.bodies.get(p.id);
      if (!body) {
        const collider = world.createCollider(R.ColliderDesc.capsule(capsuleHalf(height), RADIUS).setCollisionGroups(BODY_GROUPS));
        body = { collider, height };
        this.bodies.set(p.id, body);
      } else if (body.height !== height) {
        body.collider.setHalfHeight(capsuleHalf(height));
        body.height = height;
      }
      if (body.collider.isEnabled() !== p.solid) body.collider.setEnabled(p.solid);
      body.collider.setTranslation({ x: p.x, y: p.y + SKIN + height / 2, z: p.z });
    }
    for (const [id, body] of this.bodies) {
      if (seen.has(id)) continue;
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
