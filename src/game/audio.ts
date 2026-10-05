// Game sound: recorded samples (public/sounds/, see the README's Credits) played through Web Audio.
// Every clip is loaded once when audio starts; a sound asked for before its clip has loaded is
// simply skipped. Effects and music have their own volume (from the settings), and everything
// then goes through one limiter so stacked sounds (gunfire + footsteps) don't clip.
import { settings } from './settings';

let ctx: AudioContext | null = null;
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
}

/** Play a clip. Returns its source and gain (for loops that are faded and stopped later). */
function play(name: string, opts: PlayOptions = {}): { src: AudioBufferSourceNode; gain: GainNode } | null {
  const buffer = buffers.get(name);
  const dest = opts.bus === 'music' ? music : out;
  if (!ctx || !buffer || !dest) return null;
  const volume = opts.volume ?? 1;
  if (volume < 0.01) return null;
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.playbackRate.value = opts.rate ?? 1;
  src.loop = !!opts.loop;
  const gain = ctx.createGain();
  gain.gain.value = volume;
  let node: AudioNode = src;
  if (opts.lowpass) {
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = opts.lowpass;
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
  if (opts.pan) {
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

// ---------------------------------------------------------------- weapons

export type GunSound = 'rifle' | 'shotgun' | 'sniper' | 'deagle';

/**
 * A gunshot. `volume` already falls with distance; quieter (farther) shots are also muffled,
 * the way distant gunfire loses its crack.
 */
export function playShot(volume = 1, gun: GunSound = 'rifle'): void {
  const far = Math.max(0, Math.min(1, 1 - volume));
  play(`shot_${gun}`, { volume: Math.min(1, volume * 1.1), rate: vary(0.03), lowpass: 18000 - far * 15000 });
}

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

/** A reload, matched to the gun: magazine, shells or rounds, then the bolt, pump or slide. */
export function playReload(volume = 1, gun: GunSound = 'rifle'): void {
  const { rate = 1, steps } = RELOADS[gun];
  const pitch = rate * vary(0.03);
  for (const [clip, at] of steps) play(clip, { volume: 0.8 * volume, rate: pitch, delay: at });
}

/** Pulling the trigger on an empty magazine. */
export const playEmpty = () => { play('empty', { volume: 0.5, rate: 1.4 }); };

/** A molotov bursting: glass and a whoomph of fire. */
export function playMolotov(volume = 1): void {
  const far = Math.max(0, Math.min(1, 1 - volume));
  play('hit_head', { volume: 0.8 * volume, rate: 0.7 * vary(0.05), lowpass: 16000 - far * 13000 });
  play('explosion', { volume: 0.55 * volume, rate: 1.6 * vary(0.05), lowpass: 4000 - far * 2500, delay: 0.05 });
}

/** A flashbang: a sharp bang and a ringing tone. */
export function playFlashbang(volume = 1): void {
  const far = Math.max(0, Math.min(1, 1 - volume));
  play('explosion_crunch', { volume, rate: 1.7 * vary(0.04), lowpass: 18000 - far * 14000 });
  play('hit_head', { volume: 0.5 * volume, rate: 0.5, delay: 0.08 });
}

export function playExplosion(volume = 1): void {
  const far = Math.max(0, Math.min(1, 1 - volume));
  play('explosion', { volume, rate: vary(0.04), lowpass: 16000 - far * 13000 });
  play('explosion_crunch', { volume: volume * 0.7, rate: vary(0.04), lowpass: 16000 - far * 13000 });
}

// ---------------------------------------------------------------- hits, kills, UI

export const playHit = (head: boolean) => { play(head ? 'hit_head' : 'hit_body', { volume: head ? 0.7 : 0.5, rate: head ? 1.1 : 1.3 }); };
export const playHurt = () => { play('hurt', { volume: 0.8, rate: vary(0.08) }); };
export const playKill = () => { play('kill', { volume: 0.6 }); };
export const playPickup = () => { play('pickup', { volume: 0.55 }); };
export const playAbility = () => { play('ability', { volume: 0.5, rate: vary(0.04) }); };
export const playDenied = () => { play('denied', { volume: 0.45 }); };

/** The flag pole cutting the air. */
export function playSwing(volume = 1, pan = 0): void {
  play('swing', { volume: 0.6 * volume, pan, rate: 1.3 * vary() });
}

/** The pole connecting: a heavy thump. */
export function playMeleeHit(volume = 1, pan = 0): void {
  play('melee_hit', { volume: 0.9 * volume, pan, rate: vary(0.08), bass: 4 });
}

// ---------------------------------------------------------------- movement

/** What a foot lands on: the map's floor, or the top of a crate. */
export type Surface = 'hard' | 'sand' | 'snow' | 'wood';

/** A slide: a heavy cloth thud, then the scuff of the floor under you. */
export function playSlide(surface: Surface, volume = 1, pan = 0): void {
  play('slide', { volume: 0.7 * volume, pan, rate: vary(), bass: 3 });
  play(`step_${surface}_${Math.floor(Math.random() * STEP_VARIANTS)}`, { volume: 0.8 * volume, pan, rate: 0.75, delay: 0.05 });
}

/**
 * One footstep on `surface`, a random take of five with a little pitch variation. The low end is
 * boosted so steps have weight; landings are slower (deeper) and heavier still.
 * @param volume 0..1, already scaled for distance
 * @param pan -1 (left) .. 1 (right)
 */
export function playFootstep(surface: Surface, volume = 1, pan = 0, landing = false): void {
  const take = Math.floor(Math.random() * STEP_VARIANTS);
  play(`step_${surface}_${take}`, {
    volume: Math.min(1.4, volume * (landing ? 1.6 : 1.1)),
    pan,
    rate: (landing ? 0.82 : 1) * vary(),
    bass: landing ? 9 : 6,
    lowpass: volume < 0.3 ? 4000 : undefined,
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
