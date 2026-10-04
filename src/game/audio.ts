// Tiny Web Audio synth so the game needs no sound assets.
let ctx: AudioContext | null = null;
let noise: AudioBuffer | null = null;
/** Everything plays through this, so stacked sounds (gunfire + deep footsteps) don't clip. */
let out: AudioNode | null = null;

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
  out = limiter;
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
  const dest = out ?? ac.destination;
  if (pan) {
    const panner = ac.createStereoPanner();
    panner.pan.value = Math.max(-1, Math.min(1, pan));
    gain.connect(panner).connect(dest);
  } else {
    gain.connect(dest);
  }
  return { gain, t };
}

/** Shape of each gun's report: a filtered noise crack plus a falling low thump. */
const GUN_SOUNDS: Record<'rifle' | 'shotgun' | 'sniper' | 'deagle', {
  crack: number; crackDecay: number; filterFrom: number; filterTo: number;
  thump: number; thumpFrom: number; thumpTo: number; thumpDecay: number;
}> = {
  rifle: { crack: 0.35, crackDecay: 0.18, filterFrom: 4000, filterTo: 300, thump: 0.5, thumpFrom: 160, thumpTo: 40, thumpDecay: 0.12 },
  shotgun: { crack: 0.55, crackDecay: 0.32, filterFrom: 2600, filterTo: 180, thump: 0.8, thumpFrom: 110, thumpTo: 32, thumpDecay: 0.22 },
  sniper: { crack: 0.6, crackDecay: 0.55, filterFrom: 7000, filterTo: 250, thump: 0.65, thumpFrom: 180, thumpTo: 38, thumpDecay: 0.2 },
  deagle: { crack: 0.45, crackDecay: 0.24, filterFrom: 3200, filterTo: 220, thump: 0.75, thumpFrom: 140, thumpTo: 34, thumpDecay: 0.16 },
};

export function playShot(volume = 1, gun: keyof typeof GUN_SOUNDS = 'rifle'): void {
  if (!ctx || !noise || volume < 0.01) return;
  const sound = GUN_SOUNDS[gun];
  const { gain, t } = envelope(ctx, sound.crack * volume, sound.crackDecay);
  const src = ctx.createBufferSource();
  src.buffer = noise;
  src.loop = sound.crackDecay > 0.3;
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.setValueAtTime(sound.filterFrom, t);
  filter.frequency.exponentialRampToValueAtTime(sound.filterTo, t + sound.crackDecay * 0.85);
  src.connect(filter).connect(gain);
  src.start(t);
  src.stop(t + sound.crackDecay + 0.02);

  const thump = envelope(ctx, sound.thump * volume, sound.thumpDecay);
  const osc = ctx.createOscillator();
  osc.frequency.setValueAtTime(sound.thumpFrom, t);
  osc.frequency.exponentialRampToValueAtTime(sound.thumpTo, t + sound.thumpDecay);
  osc.connect(thump.gain);
  osc.start(t);
  osc.stop(t + sound.thumpDecay + 0.01);
}

/** A pickup gun being swapped in: two quick metallic clicks. */
export const playSwitch = () => { blip(900, 0.06, 0.03, 'square'); blip(650, 0.07, 0.04, 'square', 0.12); };

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
  /** Deep thud of body weight landing: a falling sine (plus a quiet octave so small speakers still carry it) */
  deep: number;
  deepFreq: number;
  deepDecay: number;
  /** Low, muffled noise under the step (filtered below ~250 Hz) */
  body: number;
}

const STEP_SOUNDS: Record<Surface, StepSound> = {
  hard: {
    filter: 'bandpass', freq: 1700, q: 0.9, noise: 0.22, noiseDecay: 0.06, thump: 0.3, thumpFreq: 110, thumpDecay: 0.07,
    deep: 0.42, deepFreq: 62, deepDecay: 0.16, body: 0.18,
  },
  sand: {
    filter: 'lowpass', freq: 900, q: 0.7, noise: 0.3, noiseDecay: 0.13, thump: 0.12, thumpFreq: 80, thumpDecay: 0.08,
    deep: 0.32, deepFreq: 55, deepDecay: 0.2, body: 0.26,
  },
  snow: {
    filter: 'highpass', freq: 2400, q: 0.8, noise: 0.25, noiseDecay: 0.11, thump: 0.1, thumpFreq: 90, thumpDecay: 0.07,
    deep: 0.28, deepFreq: 58, deepDecay: 0.18, body: 0.22,
  },
  // Hollow crate tops ring a little longer.
  wood: {
    filter: 'bandpass', freq: 520, q: 2.5, noise: 0.3, noiseDecay: 0.08, thump: 0.38, thumpFreq: 170, thumpDecay: 0.11,
    deep: 0.4, deepFreq: 76, deepDecay: 0.24, body: 0.14,
  },
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

  playDeep(ctx, noise, sound, volume * vary(), pan, landing);

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

/** The low end of a step: a falling sine thud and a burst of low noise. Landings go deeper and longer. */
function playDeep(ac: AudioContext, buffer: AudioBuffer, sound: StepSound, volume: number, pan: number, landing: boolean): void {
  const weight = landing ? 1.5 : 1;
  const decay = sound.deepDecay * (landing ? 1.7 : 1);
  const freq = sound.deepFreq * (landing ? 0.8 : 1) * (0.92 + Math.random() * 0.16);

  const thud = envelope(ac, sound.deep * volume * weight, decay, 0, pan);
  // A few ms of attack: an instant start at this frequency would click.
  thud.gain.gain.setValueAtTime(0.0001, thud.t);
  thud.gain.gain.exponentialRampToValueAtTime(sound.deep * volume * weight, thud.t + 0.006);
  thud.gain.gain.exponentialRampToValueAtTime(0.0001, thud.t + decay);
  for (const [mult, level] of [[1, 1], [2, 0.35]] as const) {
    const osc = ac.createOscillator();
    const partial = ac.createGain();
    partial.gain.value = level;
    osc.frequency.setValueAtTime(freq * mult, thud.t);
    osc.frequency.exponentialRampToValueAtTime(freq * mult * 0.6, thud.t + decay);
    osc.connect(partial).connect(thud.gain);
    osc.start(thud.t);
    osc.stop(thud.t + decay + 0.02);
  }

  if (!sound.body) return;
  const body = envelope(ac, sound.body * volume * weight, decay * 0.7, 0, pan);
  const src = ac.createBufferSource();
  src.buffer = buffer;
  const low = ac.createBiquadFilter();
  low.type = 'lowpass';
  low.frequency.value = 250;
  low.Q.value = 0.9;
  src.connect(low).connect(body.gain);
  src.start(body.t, Math.random() * 0.3);
  src.stop(body.t + decay);
}
