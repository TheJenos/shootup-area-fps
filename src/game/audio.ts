// Game sound: recorded samples (public/sounds/, see the README's Credits) played through Web Audio.
// Every clip is loaded once when audio starts; a sound asked for before its clip has loaded is
// simply skipped. Effects and music have their own volume (from the settings), and everything
// then goes through one limiter so stacked sounds (gunfire + footsteps) don't clip.
//
// Sounds out in the world (others' shots, steps, reloads, blasts...) are played from where they happen:
// through a PannerNode with HRTF (front / behind / above, for headphones; plain panning when the setting is
// off), heard from wherever the camera is (setListener: our eyes, or whoever's we're watching through),
// fading with distance, muffled when far, and muffled and quieter with a wall in the way (Where.occluded).
// Our own sounds and the interface stay centred.
import { settings } from './settings';

let ctx: AudioContext | null = null;
/** Where the listener is (the camera), for working out distances */
const listener = { x: 0, y: 0, z: 0 };
let out: GainNode | null = null;
let music: GainNode | null = null;
const buffers = new Map<string, AudioBuffer>();

const SOUND_URL = `${import.meta.env.BASE_URL}sounds/`;
const STEP_VARIANTS = 5;

/** Every clip the game uses (file names in public/sounds/, without .mp3). */
const CLIPS = [
  'shot_rifle', 'shot_shotgun', 'shot_sniper', 'shot_deagle',
  'reload_rifle', 'reload_deagle', 'reload_shell', 'reload_pump', 'reload_clip', 'reload_round', 'reload_bolt', 'empty', 'switch',
  'explosion', 'explosion_crunch',
  'hit_body', 'hit_head', 'hurt', 'kill', 'melee_hit', 'swing',
  'pickup', 'ability', 'denied', 'slide',
  'multi_2', 'multi_3', 'multi_4', 'multi_5', 'streak', 'lead_gain', 'lead_lost',
  'round_start', 'round_win', 'round_lose', 'round_draw',
  'heartbeat_slow', 'heartbeat_fast', 'tension_loop',
  ...(['hard', 'sand', 'snow', 'wood'] as const).flatMap((s) => Array.from({ length: STEP_VARIANTS }, (_, i) => `step_${s}_${i}`)),
];

export function initAudio(): void {
  if (ctx) {
    void ctx.resume();
    return;
  }
  ctx = new AudioContext();
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -10;
  limiter.knee.value = 6;
  limiter.ratio.value = 8;
  limiter.attack.value = 0.003;
  limiter.release.value = 0.15;
  limiter.connect(ctx.destination);
  out = ctx.createGain();
  out.connect(limiter);
  music = ctx.createGain();
  music.connect(limiter);
  applyVolumes();
  settings.subscribe(applyVolumes);
  void loadClips(ctx);
}

function applyVolumes(): void {
  if (!ctx || !out || !music) return;
  const { sfxVolume, musicVolume } = settings.get();
  out.gain.setTargetAtTime(sfxVolume, ctx.currentTime, 0.05);
  music.gain.setTargetAtTime(musicVolume, ctx.currentTime, 0.05);
}

/** Fetch and decode every clip in parallel; a clip that fails to load just stays silent. */
async function loadClips(ac: AudioContext): Promise<void> {
  await Promise.all(CLIPS.map(async (name) => {
    try {
      const res = await fetch(`${SOUND_URL}${name}.mp3`);
      if (!res.ok) throw new Error(String(res.status));
      buffers.set(name, await ac.decodeAudioData(await res.arrayBuffer()));
    } catch (err) {
      console.warn(`Sound ${name} didn't load`, err);
    }
  }));
}

/** Where a sound comes from, in the world; `occluded`: there's a wall between it and the listener */
export interface Where {
  x: number;
  y: number;
  z: number;
  occluded?: boolean;
}

/** Heard through a wall: everything above this is cut (Hz), and it's this much quieter */
const OCCLUDED_CUTOFF = 900;
const OCCLUDED_GAIN = 0.55;

/**
 * Hear from here, facing `forward` with `up` up (the camera's, every frame). Positions are set directly
 * rather than scheduled: they change every frame and nothing needs them smoothed.
 */
export function setListener(px: number, py: number, pz: number, fx: number, fy: number, fz: number, ux: number, uy: number, uz: number): void {
  listener.x = px;
  listener.y = py;
  listener.z = pz;
  if (!ctx) return;
  const l = ctx.listener;
  if (l.positionX) {
    l.positionX.value = px;
    l.positionY.value = py;
    l.positionZ.value = pz;
    l.forwardX.value = fx;
    l.forwardY.value = fy;
    l.forwardZ.value = fz;
    l.upX.value = ux;
    l.upY.value = uy;
    l.upZ.value = uz;
  } else {
    // Older Safari: only the deprecated setters.
    l.setPosition(px, py, pz);
    l.setOrientation(fx, fy, fz, ux, uy, uz);
  }
}

/**
 * The node that puts a sound at `at` (null for a sound with no place), and what that does to it: how loud it
 * still is after the distance falloff (the panner's own: 1 within `ref` metres, then ref / distance), and the
 * lowpass it needs (far sounds lose their crack when `muffle`, a wall muffles anything).
 */
function placeAt(ac: AudioContext, at: Where, ref: number, muffle: boolean): { panner: PannerNode; falloff: number; cutoff: number | null; gain: number } {
  const d = Math.hypot(at.x - listener.x, at.y - listener.y, at.z - listener.z);
  const falloff = ref / (ref + Math.max(0, d - ref));
  let cutoff: number | null = muffle ? 18000 - (1 - falloff) * 15000 : null;
  let gain = 1;
  if (at.occluded) {
    cutoff = Math.min(cutoff ?? OCCLUDED_CUTOFF, OCCLUDED_CUTOFF);
    gain = OCCLUDED_GAIN;
  }
  const panner = ac.createPanner();
  panner.panningModel = settings.get().spatialAudio ? 'HRTF' : 'equalpower';
  panner.distanceModel = 'inverse';
  panner.refDistance = ref;
  panner.rolloffFactor = 1;
  panner.maxDistance = 10000;
  if (panner.positionX) {
    panner.positionX.value = at.x;
    panner.positionY.value = at.y;
    panner.positionZ.value = at.z;
  } else {
    panner.setPosition(at.x, at.y, at.z);
  }
  return { panner, falloff, cutoff, gain };
}

interface PlayOptions {
  /** 0..1 (and a little above for emphasis) */
  volume?: number;
  /** -1 (left) .. 1 (right) */
  pan?: number;
  /** Playback speed; also shifts pitch (1 = as recorded) */
  rate?: number;
  /** Seconds from now */
  delay?: number;
  /** Lowpass cutoff (Hz): muffles far-away sounds */
  lowpass?: number;
  /** Boost the low end (dB at ~120 Hz): weightier footsteps and landings */
  bass?: number;
  /** Which bus: effects (default) or music */
  bus?: 'sfx' | 'music';
  loop?: boolean;
  /** Play from this spot in the world; `volume` is then how loud it is up close (distance does the rest) */
  at?: Where;
  /** With `at`: full volume within this many metres, falling off beyond */
  ref?: number;
  /** With `at`: far away also sounds muffled (gunfire and blasts lose their crack) */
  muffle?: boolean;
}

/** Play a clip. Returns its source and gain (for loops that are faded and stopped later). */
function play(name: string, opts: PlayOptions = {}): { src: AudioBufferSourceNode; gain: GainNode } | null {
  const buffer = buffers.get(name);
  const dest = opts.bus === 'music' ? music : out;
  if (!ctx || !buffer || !dest) return null;
  let volume = opts.volume ?? 1;
  let lowpass = opts.lowpass;
  let place: ReturnType<typeof placeAt> | null = null;
  if (opts.at) {
    place = placeAt(ctx, opts.at, opts.ref ?? 4, !!opts.muffle);
    // Too far to hear: don't play it at all.
    if (volume * place.falloff * place.gain < 0.01) return null;
    volume *= place.gain;
    if (place.cutoff !== null) lowpass = Math.min(lowpass ?? Infinity, place.cutoff);
  }
  if (volume < 0.01) return null;
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.playbackRate.value = opts.rate ?? 1;
  src.loop = !!opts.loop;
  const gain = ctx.createGain();
  gain.gain.value = volume;
  let node: AudioNode = src;
  if (lowpass) {
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = lowpass;
    node = node.connect(lp);
  }
  if (opts.bass) {
    const shelf = ctx.createBiquadFilter();
    shelf.type = 'lowshelf';
    shelf.frequency.value = 120;
    shelf.gain.value = opts.bass;
    node = node.connect(shelf);
  }
  node = node.connect(gain);
  if (place) {
    node.connect(place.panner).connect(dest);
  } else if (opts.pan) {
    const panner = ctx.createStereoPanner();
    panner.pan.value = Math.max(-1, Math.min(1, opts.pan));
    node.connect(panner).connect(dest);
  } else {
    node.connect(dest);
  }
  src.start(ctx.currentTime + (opts.delay ?? 0));
  return { src, gain };
}

/** A little random pitch so repeated sounds (steps, shots) don't sound like a machine. */
const vary = (amount = 0.06) => 1 + (Math.random() * 2 - 1) * amount;

/**
 * A synthesised tone, no clip needed: the bomb's beeps and the plant / defuse ticks are electronic
 * anyway. `ms` long, starting `delay` s from now, on the effects bus.
 */
export function playTone(freq: number, ms: number, volume = 0.4, type: OscillatorType = 'square', delay = 0, at?: Where, ref = 4): void {
  if (!ctx || !out || volume < 0.01) return;
  const place = at ? placeAt(ctx, at, ref, false) : null;
  if (place) {
    if (volume * place.falloff * place.gain < 0.01) return;
    volume *= place.gain;
  }
  const osc = ctx.createOscillator();
  osc.type = type;
  osc.frequency.value = freq;
  const gain = ctx.createGain();
  const t0 = ctx.currentTime + delay;
  const t1 = t0 + ms / 1000;
  gain.gain.setValueAtTime(0, t0);
  gain.gain.linearRampToValueAtTime(volume, t0 + 0.005);
  gain.gain.exponentialRampToValueAtTime(0.001, t1);
  if (place) {
    let node: AudioNode = osc.connect(gain);
    if (place.cutoff !== null) {
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = place.cutoff;
      node = node.connect(lp);
    }
    node.connect(place.panner).connect(out);
  } else {
    osc.connect(gain).connect(out);
  }
  osc.start(t0);
  osc.stop(t1 + 0.02);
}

// ---------------------------------------------------------------- search & destroy

/** The planted bomb's beep, from the bomb (`at`); without a place, `volume` already falls with distance */
export const playBombBeep = (volume = 1, at?: Where) => { playTone(1680, 70, 0.35 * volume, 'square', 0, at, 15); };
/** Planting or defusing: a tick every half second of holding the key */
export const playChannelTick = () => { playTone(900, 35, 0.22, 'sine'); };
/** Three rising notes: the bomb is down */
export function playBombPlanted(): void {
  [660, 880, 1320].forEach((f, i) => playTone(f, 170, 0.3, 'triangle', i * 0.12));
}
/** Falling notes: the bomb is safe */
export function playBombDefused(): void {
  [1320, 880, 660].forEach((f, i) => playTone(f, 190, 0.3, 'triangle', i * 0.14));
}

// ---------------------------------------------------------------- weapons

export type GunSound = 'rifle' | 'shotgun' | 'sniper' | 'deagle';

/**
 * A gunshot: ours (no `at`, centred), or someone else's from where they fired. Farther shots are also
 * muffled, the way distant gunfire loses its crack. Without a place, `volume` already falls with distance.
 */
export function playShot(volume = 1, gun: GunSound = 'rifle', at?: Where): void {
  if (at) {
    play(`shot_${gun}`, { volume: Math.min(1, volume * 1.1), rate: vary(0.03), at, ref: 8, muffle: true });
    return;
  }
  const far = Math.max(0, Math.min(1, 1 - volume));
  play(`shot_${gun}`, { volume: Math.min(1, volume * 1.1), rate: vary(0.03), lowpass: 18000 - far * 15000 });
}

/** How a blast-like sound is placed: from `at` (muffled with distance), else muffled by how quiet `volume` already is */
const blastAt = (volume: number, at: Where | undefined, cutoffNear: number, cutoffSpan: number, ref = 10): Pick<PlayOptions, 'at' | 'ref' | 'muffle' | 'lowpass'> =>
  (at ? { at, ref, muffle: true } : { lowpass: cutoffNear - Math.max(0, Math.min(1, 1 - volume)) * cutoffSpan });

/** Switching guns: a metallic clack. */
export const playSwitch = () => { play('switch', { volume: 0.55, rate: vary() }); };

/**
 * Each gun's reload as [clip, seconds from the start], laid out to finish inside its reload time (guns.ts):
 * the rifle's mag out / in / charging handle and the pistol's mag drop / insert / slide are one recording
 * each; the shotgun loads shells then racks the pump; the bolt-action loads rounds then works the bolt.
 */
const RELOADS: Record<GunSound, { rate?: number; steps: [string, number][] }> = {
  rifle: { rate: 1.12, steps: [['reload_rifle', 0]] }, // 1.56 s recording into the 1.4 s reload
  deagle: { steps: [['reload_deagle', 0]] }, // 1.59 s, the reload is 1.6 s
  shotgun: { steps: [['reload_shell', 0.05], ['reload_shell', 0.5], ['reload_shell', 0.95], ['reload_pump', 1.3]] }, // 2 s
  sniper: { steps: [['reload_bolt', 0], ['reload_clip', 0.6], ['reload_round', 1.05], ['reload_round', 1.4], ['reload_bolt', 1.85]] }, // 2.4 s
};

/** A reload, matched to the gun: magazine, shells or rounds, then the bolt, pump or slide (from `where`, someone else's). */
export function playReload(volume = 1, gun: GunSound = 'rifle', where?: Where): void {
  const { rate = 1, steps } = RELOADS[gun];
  const pitch = rate * vary(0.03);
  for (const [clip, at] of steps) play(clip, { volume: 0.8 * volume, rate: pitch, delay: at, ...(where ? { at: where } : {}) });
}

/** Pulling the trigger on an empty magazine. */
export const playEmpty = () => { play('empty', { volume: 0.5, rate: 1.4 }); };

/** A molotov bursting: glass and a whoomph of fire. */
export function playMolotov(volume = 1, at?: Where): void {
  play('hit_head', { volume: 0.8 * volume, rate: 0.7 * vary(0.05), ...blastAt(volume, at, 16000, 13000) });
  play('explosion', { volume: 0.55 * volume, rate: 1.6 * vary(0.05), delay: 0.05, ...blastAt(volume, at, 4000, 2500), ...(at ? { lowpass: 4000 } : {}) });
}

/** A flashbang: a sharp bang and a ringing tone. */
export function playFlashbang(volume = 1, at?: Where): void {
  play('explosion_crunch', { volume, rate: 1.7 * vary(0.04), ...blastAt(volume, at, 18000, 14000) });
  play('hit_head', { volume: 0.5 * volume, rate: 0.5, delay: 0.08, ...(at ? { at, ref: 10 } : {}) });
}

/** A barrier breaking: a crunch and a clatter. */
export function playBreak(volume = 1, at?: Where): void {
  play('explosion_crunch', { volume: 0.7 * volume, rate: 1.5 * vary(0.05), ...blastAt(volume, at, 16000, 12000) });
  play('hit_body', { volume: 0.6 * volume, rate: 0.6 * vary(0.05), delay: 0.04, ...(at ? { at, ref: 10 } : {}) });
}

/** A grenade, mine or the bomb going off (`ref`: how far it stays at full volume; the bomb carries much further). */
export function playExplosion(volume = 1, at?: Where, ref = 10): void {
  play('explosion', { volume, rate: vary(0.04), ...blastAt(volume, at, 16000, 13000, ref) });
  play('explosion_crunch', { volume: volume * 0.7, rate: vary(0.04), ...blastAt(volume, at, 16000, 13000, ref) });
}

// ---------------------------------------------------------------- hits, kills, UI

export const playHit = (head: boolean) => { play(head ? 'hit_head' : 'hit_body', { volume: head ? 0.7 : 0.5, rate: head ? 1.1 : 1.3 }); };
export const playHurt = () => { play('hurt', { volume: 0.8, rate: vary(0.08) }); };
export const playKill = () => { play('kill', { volume: 0.6 }); };
export const playPickup = () => { play('pickup', { volume: 0.55 }); };
export const playAbility = (at?: Where) => { play('ability', { volume: 0.5, rate: vary(0.04), at, ref: 6 }); };
export const playDenied = () => { play('denied', { volume: 0.45 }); };

/** The flag pole cutting the air (from `at`: someone else's swing). */
export function playSwing(volume = 1, pan = 0, at?: Where): void {
  play('swing', { volume: 0.6 * volume, pan, rate: 1.3 * vary(), at });
}

/** A knife slash: a quick, light whoosh. */
export function playKnife(volume = 1, pan = 0, at?: Where): void {
  play('swing', { volume: 0.5 * volume, pan, rate: 1.9 * vary(), at });
}

/** The knife connecting: a sharp, short hit (the club's thump, higher and lighter). */
export function playKnifeHit(volume = 1, pan = 0, at?: Where): void {
  play('melee_hit', { volume: 0.7 * volume, pan, rate: 1.6 * vary(0.08), at });
}

/** The pole connecting: a heavy thump. */
export function playMeleeHit(volume = 1, pan = 0, at?: Where): void {
  play('melee_hit', { volume: 0.9 * volume, pan, rate: vary(0.08), bass: 4, at });
}

// ---------------------------------------------------------------- movement

/** What a foot lands on: the map's floor, or the top of a crate. */
export type Surface = 'hard' | 'sand' | 'snow' | 'wood';

/** A slide: a heavy cloth thud, then the scuff of the floor under you (from `at`: someone else's). */
export function playSlide(surface: Surface, volume = 1, pan = 0, at?: Where): void {
  play('slide', { volume: 0.7 * volume, pan, rate: vary(), bass: 3, at });
  play(`step_${surface}_${Math.floor(Math.random() * STEP_VARIANTS)}`, { volume: 0.8 * volume, pan, rate: 0.75, delay: 0.05, at });
}

/**
 * One footstep on `surface`, a random take of five with a little pitch variation. The low end is
 * boosted so steps have weight; landings are slower (deeper) and heavier still.
 * @param volume 0..1: how loud the step is (with `at`); without it, already scaled for distance
 * @param pan -1 (left) .. 1 (right), without `at`
 * @param at where someone else's step lands (distance, direction and walls do the rest)
 */
export function playFootstep(surface: Surface, volume = 1, pan = 0, landing = false, at?: Where): void {
  const take = Math.floor(Math.random() * STEP_VARIANTS);
  play(`step_${surface}_${take}`, {
    volume: Math.min(1.4, volume * (landing ? 1.6 : 1.1)),
    pan,
    rate: (landing ? 0.82 : 1) * vary(),
    bass: landing ? 9 : 6,
    ...(at ? { at, muffle: true } : { lowpass: volume < 0.3 ? 4000 : undefined }),
  });
}

// ---------------------------------------------------------------- announcer stingers

/** Multi-kill stingers: each one up the ladder is bigger. */
export function playMultiKill(count: number): void {
  play(`multi_${Math.min(5, Math.max(2, count))}`, { volume: 0.75, bus: 'music' });
}

/** Kill streak milestone (5, 10, 15...). */
export const playStreak = () => { play('streak', { volume: 0.75, bus: 'music' }); };

/** Free-for-all: you took the outright lead, or lost it. */
export const playLeadGained = () => { play('lead_gain', { volume: 0.75, bus: 'music' }); };
export const playLeadLost = () => { play('lead_lost', { volume: 0.7, bus: 'music' }); };

export const playRoundStart = () => { play('round_start', { volume: 0.7, bus: 'music' }); };

export function playRoundEnd(outcome: 'won' | 'lost' | 'draw'): void {
  play(outcome === 'won' ? 'round_win' : outcome === 'lost' ? 'round_lose' : 'round_draw', { volume: 0.8, bus: 'music' });
}

/** One heartbeat, for the low-health pulse; closer to death it's the faster, harder take. */
export function playHeartbeat(volume = 1): void {
  play(volume > 0.75 ? 'heartbeat_fast' : 'heartbeat_slow', { volume: 0.8 * volume, bass: 4 });
}

// ---------------------------------------------------------------- round music

let bed: { src: AudioBufferSourceNode; gain: GainNode } | null = null;

/** The last-30-seconds music: a dark loop that fades in (see setRoundBedUrgency). */
export function startRoundBed(): void {
  if (!ctx || bed) return;
  bed = play('tension_loop', { volume: 0.0001, bus: 'music', loop: true });
  bed?.gain.gain.exponentialRampToValueAtTime(0.6, ctx.currentTime + 2);
}

/** 0 at thirty seconds left, 1 at zero: the loop speeds up a touch and gets louder. */
export function setRoundBedUrgency(urgency: number): void {
  if (!ctx || !bed) return;
  const u = Math.max(0, Math.min(1, urgency));
  bed.src.playbackRate.setTargetAtTime(1 + 0.12 * u, ctx.currentTime, 0.5);
  bed.gain.gain.setTargetAtTime(0.6 + 0.35 * u, ctx.currentTime, 0.5);
}

export function stopRoundBed(): void {
  if (!ctx || !bed) return;
  const b = bed;
  bed = null;
  b.gain.gain.setTargetAtTime(0.0001, ctx.currentTime, 0.4);
  b.src.stop(ctx.currentTime + 2);
}
