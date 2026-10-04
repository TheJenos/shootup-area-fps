// Tiny Web Audio synth so the game needs no sound assets.
let ctx: AudioContext | null = null;
let noise: AudioBuffer | null = null;

export function initAudio(): void {
  if (ctx) {
    void ctx.resume();
    return;
  }
  ctx = new AudioContext();
  noise = ctx.createBuffer(1, ctx.sampleRate * 0.4, ctx.sampleRate);
  const data = noise.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
}

/** @param pan -1 (left) .. 1 (right) */
function envelope(ac: AudioContext, peak: number, duration: number, delay = 0, pan = 0) {
  const gain = ac.createGain();
  const t = ac.currentTime + delay;
  gain.gain.setValueAtTime(peak, t);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + duration);
  if (pan) {
    const panner = ac.createStereoPanner();
    panner.pan.value = Math.max(-1, Math.min(1, pan));
    gain.connect(panner).connect(ac.destination);
  } else {
    gain.connect(ac.destination);
  }
  return { gain, t };
}

export function playShot(volume = 1): void {
  if (!ctx || !noise || volume < 0.01) return;
  const { gain, t } = envelope(ctx, 0.35 * volume, 0.18);
  const src = ctx.createBufferSource();
  src.buffer = noise;
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.setValueAtTime(4000, t);
  filter.frequency.exponentialRampToValueAtTime(300, t + 0.15);
  src.connect(filter).connect(gain);
  src.start(t);
  src.stop(t + 0.2);

  const thump = envelope(ctx, 0.5 * volume, 0.12);
  const osc = ctx.createOscillator();
  osc.frequency.setValueAtTime(160, t);
  osc.frequency.exponentialRampToValueAtTime(40, t + 0.12);
  osc.connect(thump.gain);
  osc.start(t);
  osc.stop(t + 0.13);
}

export function playExplosion(volume = 1): void {
  if (!ctx || !noise || volume < 0.01) return;
  const { gain, t } = envelope(ctx, 0.9 * volume, 0.7);
  const src = ctx.createBufferSource();
  src.buffer = noise;
  src.loop = true;
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.setValueAtTime(1200, t);
  filter.frequency.exponentialRampToValueAtTime(80, t + 0.6);
  src.connect(filter).connect(gain);
  src.start(t);
  src.stop(t + 0.75);
}

function blip(freq: number, peak: number, duration: number, type: OscillatorType = 'sine', delay = 0): void {
  if (!ctx) return;
  const { gain, t } = envelope(ctx, peak, duration, delay);
  const osc = ctx.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  osc.connect(gain);
  osc.start(t);
  osc.stop(t + duration + 0.01);
}

export const playHit = (head: boolean) => blip(head ? 1800 : 1200, 0.15, 0.06, 'square');
export const playHurt = () => blip(90, 0.4, 0.2, 'sawtooth');
export const playKill = () => { blip(880, 0.15, 0.1); blip(1320, 0.15, 0.15, 'sine', 0.08); };
export const playReload = () => { blip(400, 0.08, 0.04, 'square'); blip(600, 0.08, 0.04, 'square', 0.9); };
export const playEmpty = () => blip(250, 0.08, 0.03, 'square');
export const playPickup = () => { blip(660, 0.12, 0.08, 'triangle'); blip(990, 0.12, 0.12, 'triangle', 0.07); };
export const playAbility = () => blip(520, 0.12, 0.15, 'triangle');
export const playDenied = () => blip(160, 0.1, 0.08, 'square');

/** Scrape of a slide along the floor. Softer surfaces muffle it. */
export function playSlide(surface: 'hard' | 'sand' | 'snow' | 'wood', volume = 1, pan = 0): void {
  if (!ctx || !noise || volume < 0.01) return;
  const { gain, t } = envelope(ctx, 0.32 * volume, 0.65, 0, pan);
  const src = ctx.createBufferSource();
  src.buffer = noise;
  src.loop = true;
  const filter = ctx.createBiquadFilter();
  filter.type = 'bandpass';
  const top = surface === 'hard' || surface === 'wood' ? 2400 : surface === 'snow' ? 3200 : 1100;
  filter.frequency.setValueAtTime(top, t);
  filter.frequency.exponentialRampToValueAtTime(top * 0.25, t + 0.6);
  filter.Q.value = 0.8;
  src.connect(filter).connect(gain);
  src.start(t, Math.random() * 0.3);
  src.stop(t + 0.7);
}

// ---------------------------------------------------------------- footsteps

/** What a foot lands on: the map's floor, or the top of a crate. */
export type Surface = 'hard' | 'sand' | 'snow' | 'wood';

interface StepSound {
  /** Filter shaping the noise burst (the scuff / crunch) */
  filter: BiquadFilterType;
  freq: number;
  q: number;
  noise: number;
  noiseDecay: number;
  /** Low thump of the heel; 0 for none */
  thump: number;
  thumpFreq: number;
  thumpDecay: number;
}

const STEP_SOUNDS: Record<Surface, StepSound> = {
  hard: { filter: 'bandpass', freq: 1700, q: 0.9, noise: 0.22, noiseDecay: 0.06, thump: 0.3, thumpFreq: 110, thumpDecay: 0.07 },
  sand: { filter: 'lowpass', freq: 900, q: 0.7, noise: 0.3, noiseDecay: 0.13, thump: 0.12, thumpFreq: 80, thumpDecay: 0.08 },
  snow: { filter: 'highpass', freq: 2400, q: 0.8, noise: 0.25, noiseDecay: 0.11, thump: 0.1, thumpFreq: 90, thumpDecay: 0.07 },
  wood: { filter: 'bandpass', freq: 520, q: 2.5, noise: 0.3, noiseDecay: 0.08, thump: 0.38, thumpFreq: 170, thumpDecay: 0.11 },
};

/**
 * One footstep. Pitch and loudness vary a little each time so a run of steps
 * doesn't sound like a machine gun.
 * @param volume 0..1, already scaled for distance
 * @param pan -1 (left) .. 1 (right)
 */
export function playFootstep(surface: Surface, volume = 1, pan = 0, landing = false): void {
  if (!ctx || !noise || volume < 0.01) return;
  const sound = STEP_SOUNDS[surface];
  const vary = () => 0.85 + Math.random() * 0.3;
  const weight = landing ? 1.8 : 1;

  const scuff = envelope(ctx, sound.noise * volume * vary() * weight, sound.noiseDecay * (landing ? 1.6 : 1), 0, pan);
  const src = ctx.createBufferSource();
  src.buffer = noise;
  const filter = ctx.createBiquadFilter();
  filter.type = sound.filter;
  filter.frequency.value = sound.freq * vary();
  filter.Q.value = sound.q;
  src.connect(filter).connect(scuff.gain);
  // Start somewhere random in the noise so no two steps are identical.
  src.start(scuff.t, Math.random() * 0.3);
  src.stop(scuff.t + sound.noiseDecay * 2);

  if (!sound.thump) return;
  const heel = envelope(ctx, sound.thump * volume * vary() * weight, sound.thumpDecay * (landing ? 1.5 : 1), 0, pan);
  const osc = ctx.createOscillator();
  const freq = sound.thumpFreq * vary() * (landing ? 0.7 : 1);
  osc.frequency.setValueAtTime(freq, heel.t);
  osc.frequency.exponentialRampToValueAtTime(freq * 0.5, heel.t + sound.thumpDecay);
  osc.connect(heel.gain);
  osc.start(heel.t);
  osc.stop(heel.t + sound.thumpDecay * 2);
}
