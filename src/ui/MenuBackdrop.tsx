import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { buildWorld } from '../game/world';
import { GENERATOR_VERSION, mapName, randomSeed, specForMode } from '../game/mapgen';
import { reducedMotion, settings } from '../game/settings';
import { TOUCH } from '../game/device';
import { useMapData } from './useMapData';

/*
 * Behind the lobby: a slow drone flight over a real generated map, as it looks in the game (its sky, fog,
 * light and props). Kept cheap: below full resolution, at most 30 frames a second, nothing while the tab is
 * hidden. On touch screens, on low quality and with reduced motion it's a single still frame instead, and
 * with no WebGL at all the plain gradient behind it shows.
 *
 * It waits its turn: its map is made and its world built only once the page has been idle a moment (`delay`),
 * and its shaders are compiled off the main thread where the browser can, so the lobby's first moments (and
 * an invite counting down to joining) never wait on it.
 */

/** Seconds for one lap of the map */
const LAP = 150;
const FRAME_MS = 1000 / 30;

/** @param delay ms before the world is built (it waits for an idle moment after that, too) */
export function MenuBackdrop({ delay = 1200 }: { delay?: number }) {
  // A new map each visit to the lobby (the same while it's open).
  const spec = useMemo(() => specForMode({ seed: randomSeed(), size: 'm', gen: GENERATOR_VERSION }, 'ffa'), []);
  const hostRef = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(false);
  const shownRef = useRef(false);
  /** The page has been quiet long enough to make the map and build the world */
  const [ready, setReady] = useState(false);
  const { map } = useMapData(ready ? spec : null, 0);
  useEffect(() => {
    let idle = 0;
    const timer = setTimeout(() => {
      if (typeof requestIdleCallback === 'function') idle = requestIdleCallback(() => setReady(true), { timeout: 2000 });
      else setReady(true);
    }, delay);
    return () => {
      clearTimeout(timer);
      if (idle) cancelIdleCallback(idle);
    };
  }, [delay]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !map || !ready) return;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'low-power' });
    } catch {
      return; // no WebGL: the gradient stays
    }
    const quality = settings.get().quality;
    const still = () => TOUCH || reducedMotion() || settings.get().quality === 'low';
    renderer.setPixelRatio(Math.min(1, window.devicePixelRatio || 1) * (quality === 'high' ? 1 : 0.75));
    renderer.shadowMap.enabled = quality !== 'low';
    renderer.domElement.className = 'menu-backdrop-gl';
    host.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const world = buildWorld(scene, map, { colliders: [], solids: [], ramps: [], obstacles: [] });
    world.setQuality(quality === 'high' ? 'medium' : 'low');
    const camera = new THREE.PerspectiveCamera(52, 1, 0.1, 300);
    // Over the arena, well above the tallest roof: the buildings or cliffs round the edge are the skyline,
    // never a wall filling the view (a lap out over them, just above their roofs, was mostly roof).
    const tallest = map.boxes.reduce((h, b) => Math.max(h, b.y + b.h), 0);
    const height = Math.min(40, Math.max(18, tallest + 10));
    const radius = map.half * 0.45;
    const look = new THREE.Vector3();

    let t = Math.random() * LAP;
    let last = 0;
    let frame = 0;
    const place = () => {
      const a = (t / LAP) * Math.PI * 2;
      camera.position.set(Math.cos(a) * radius, height + Math.sin(a * 2) * 1.5, Math.sin(a) * radius);
      // Looking across the middle to the far side, a little ahead of the lap, so the map turns slowly past.
      const b = a + Math.PI * 0.8;
      look.set(Math.cos(b) * radius * 0.6, 0, Math.sin(b) * radius * 0.6);
      camera.lookAt(look);
      world.sky.position.copy(camera.position);
    };
    const render = () => {
      place();
      renderer.render(scene, camera);
      shownRef.current = true;
      setShown(true);
    };
    const loop = (now: number) => {
      frame = 0;
      if (document.hidden || still()) return;
      frame = requestAnimationFrame(loop);
      if (now - last < FRAME_MS) return;
      if (last) t += Math.min(0.1, (now - last) / 1000);
      last = now;
      render();
    };
    /** Shaders ready: nothing is drawn before (or it would compile them all at once on the main thread) */
    let compiled = false;
    const start = () => {
      if (!compiled) return;
      if (still()) {
        render();
        return;
      }
      last = 0;
      if (!frame) frame = requestAnimationFrame(loop);
    };
    const size = () => {
      const w = host.clientWidth || window.innerWidth;
      const h = host.clientHeight || window.innerHeight;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      if (still()) render();
    };
    let disposed = false;
    // Shaders compiled in the background where the browser can (the first frame otherwise compiles them all at once).
    renderer.compileAsync(scene, camera)
      .catch(() => {})
      .then(() => {
        if (disposed) return;
        compiled = true;
        size();
        start();
      });
    const resize = new ResizeObserver(() => { if (shownRef.current) size(); });
    resize.observe(host);
    document.addEventListener('visibilitychange', start);
    // Motion allowed again (the setting, or the system's): the flight picks up where it stopped.
    const unsubscribe = settings.subscribe(start);
    const motion = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    motion?.addEventListener('change', start);

    return () => {
      disposed = true;
      if (frame) cancelAnimationFrame(frame);
      resize.disconnect();
      document.removeEventListener('visibilitychange', start);
      unsubscribe();
      motion?.removeEventListener('change', start);
      world.dispose();
      renderer.dispose();
      // Hand the context back now: the game is about to want its own.
      renderer.forceContextLoss();
      renderer.domElement.remove();
    };
  }, [map, ready]);

  return (
    <div className="menu-backdrop" aria-hidden="true">
      <div ref={hostRef} className={shown ? 'menu-backdrop-host shown' : 'menu-backdrop-host'} />
      <div className="menu-backdrop-shade" />
      {map && shown && <span className="menu-backdrop-caption">{mapName(map.spec.seed)}</span>}
    </div>
  );
}
