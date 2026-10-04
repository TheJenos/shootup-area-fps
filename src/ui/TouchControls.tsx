import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { Game } from '../game/game';

/** How far the stick can be pushed from where the thumb landed (px) */
const STICK_RADIUS = 56;

type PointerHandler = (e: ReactPointerEvent<HTMLElement>) => void;

/**
 * On-screen controls for phones and tablets:
 * - left half: a move stick that appears wherever the thumb lands (push fully forward to sprint)
 * - right half: drag to look around
 * - buttons: fire (drag on it to keep aiming while shooting), aim, jump, crouch / slide, reload,
 *   plus the scoreboard and menu up top. Ability slots are tapped directly in the HUD.
 * Uses pointer events, so several fingers work at once.
 */
export function TouchControls({ game, aiming, hasSpecial }: { game: Game; aiming: boolean; hasSpecial: boolean }) {
  const stick = useRef<{ id: number; x: number; y: number } | null>(null);
  const [knob, setKnob] = useState<{ x: number; y: number; dx: number; dy: number } | null>(null);
  /** Last position of each finger that is turning the view */
  const looking = useRef(new Map<number, { x: number; y: number }>());
  const [crouched, setCrouched] = useState(game.touchCrouched);

  const capture = (e: ReactPointerEvent<HTMLElement>) => {
    e.preventDefault();
    e.stopPropagation();
    // Keep receiving this finger's moves even when it slides off the control.
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch { /* pointer already gone; the control still works without capture */ }
  };

  // ---- move stick
  const stickDown: PointerHandler = (e) => {
    if (stick.current) return;
    capture(e);
    stick.current = { id: e.pointerId, x: e.clientX, y: e.clientY };
    setKnob({ x: e.clientX, y: e.clientY, dx: 0, dy: 0 });
  };
  const stickMove: PointerHandler = (e) => {
    const s = stick.current;
    if (!s || s.id !== e.pointerId) return;
    let dx = e.clientX - s.x;
    let dy = e.clientY - s.y;
    const len = Math.hypot(dx, dy);
    if (len > STICK_RADIUS) {
      dx = (dx / len) * STICK_RADIUS;
      dy = (dy / len) * STICK_RADIUS;
    }
    setKnob({ x: s.x, y: s.y, dx, dy });
    game.setTouchMove({ x: dx / STICK_RADIUS, y: -dy / STICK_RADIUS });
  };
  const stickUp: PointerHandler = (e) => {
    if (stick.current?.id !== e.pointerId) return;
    stick.current = null;
    setKnob(null);
    game.setTouchMove(null);
  };

  // ---- look (the right side, and the fire button)
  const lookDown: PointerHandler = (e) => {
    capture(e);
    looking.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
  };
  const lookMove: PointerHandler = (e) => {
    const last = looking.current.get(e.pointerId);
    if (!last) return;
    game.touchLook(e.clientX - last.x, e.clientY - last.y);
    looking.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
  };
  const lookUp: PointerHandler = (e) => {
    looking.current.delete(e.pointerId);
  };

  const fireDown: PointerHandler = (e) => {
    lookDown(e);
    game.setTouchFire(true);
  };
  const fireUp: PointerHandler = (e) => {
    lookUp(e);
    game.setTouchFire(false);
  };

  /** A tap button: fires `action` on touch, without starting a look drag underneath. */
  const tap = (action: () => void): PointerHandler => (e) => {
    capture(e);
    action();
  };
  const hold = (down: () => void, up: () => void) => ({
    onPointerDown: tap(down),
    onPointerUp: up,
    onPointerCancel: up,
  });

  return (
    <div id="touch-controls">
      <div
        className="stick-zone"
        onPointerDown={stickDown}
        onPointerMove={stickMove}
        onPointerUp={stickUp}
        onPointerCancel={stickUp}
      >
        {knob ? (
          <div className="stick active" style={{ left: knob.x, top: knob.y }}>
            <div className="knob" style={{ transform: `translate(${knob.dx}px, ${knob.dy}px)` }} />
          </div>
        ) : (
          <div className="stick idle"><div className="knob" /></div>
        )}
      </div>

      <div className="look-zone" onPointerDown={lookDown} onPointerMove={lookMove} onPointerUp={lookUp} onPointerCancel={lookUp} />

      <button
        type="button"
        className="tbtn fire"
        aria-label="Fire"
        onPointerDown={fireDown}
        onPointerMove={lookMove}
        onPointerUp={fireUp}
        onPointerCancel={fireUp}
      >
        ●
      </button>
      <button
        type="button"
        className={aiming ? 'tbtn aim on' : 'tbtn aim'}
        aria-label="Aim down sights"
        onPointerDown={tap(() => game.toggleTouchAim())}
      >
        ◎
      </button>
      <button type="button" className="tbtn jump" aria-label="Jump" {...hold(() => game.setTouchJump(true), () => game.setTouchJump(false))}>
        ⤒
      </button>
      <button
        type="button"
        className={crouched ? 'tbtn crouch on' : 'tbtn crouch'}
        aria-label="Crouch or slide"
        onPointerDown={tap(() => { game.tapTouchCrouch(); setTimeout(() => setCrouched(game.touchCrouched), 100); })}
      >
        ⤓
      </button>
      <button type="button" className="tbtn reload" aria-label="Reload" onPointerDown={tap(() => game.touchReload())}>
        ↻
      </button>
      {hasSpecial && (
        <button type="button" className="tbtn swap" aria-label="Switch gun" onPointerDown={tap(() => game.switchGun())}>
          ⇄
        </button>
      )}

      <div className="top-buttons">
        <button type="button" className="tbtn small" aria-label="Scoreboard" {...hold(() => game.setTouchScoreboard(true), () => game.setTouchScoreboard(false))}>
          ☰
        </button>
        <button type="button" className="tbtn small" aria-label="Inventory" onPointerDown={tap(() => game.touchInventory())}>
          🎒
        </button>
        <button type="button" className="tbtn small" aria-label="Menu" onPointerDown={tap(() => game.pauseTouchPlay())}>
          ❚❚
        </button>
      </div>
    </div>
  );
}
