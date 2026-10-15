import { describe, expect, it } from 'vitest';
import { ReplayRecorder, type Highlight, type ReplayEvent } from '../replay';
import type { FlagPlacement } from '../flags';
import type { Team } from '../../types';

const pose = (gun?: 'rifle' | 'shotgun' | 'sniper') => ({ name: 'Kai', color: '#fff', x: 0, y: 0, z: 0, yaw: 0, pitch: 0, alive: true, ...(gun ? { gun } : {}) });

const MINUTE = 60_000;

/** Play from `from` to `to` (ms): `a` sends a pose every 100 ms, and fires once a second. */
function play(rec: ReplayRecorder, from: number, to: number): void {
  for (let t = from; t <= to; t += 100) {
    rec.pose('a', { ...pose(), x: t / 1000 }, t);
    if (t % 1000 === 0) rec.event({ t, kind: 'shot', o: [0, 0, 0], e: [1, 0, 0], hit: false });
  }
}

describe('the replay recording', () => {
  it('keeps which gun each player held, and every switch', () => {
    const rec = new ReplayRecorder();
    rec.pose('a', pose('rifle'), 1000);
    // Within the sample gap: thinned out, unless the gun changed.
    rec.pose('a', pose('rifle'), 1010);
    rec.pose('a', pose('shotgun'), 1020);
    rec.pose('a', pose('sniper'), 1030);
    rec.pose('a', pose(), 1040);
    expect(rec.tracks.get('a')!.samples.map((s) => [s.t, s.gun])).toEqual([[1000, 'rifle'], [1020, 'shotgun'], [1030, 'sniper'], [1040, 'rifle']]);
  });

  it('keeps the last minute of a long round, and the pose from just before it', () => {
    const rec = new ReplayRecorder();
    const end = 20 * MINUTE;
    play(rec, 0, end);
    const samples = rec.tracks.get('a')!.samples;
    // About a minute of poses (it trims every few seconds), not 20.
    expect(samples.length).toBeLessThan(700);
    expect(rec.events.length).toBeLessThan(70);
    // Every pose of the last minute is there...
    const recent = samples.filter((s) => s.t >= end - MINUTE);
    expect(recent.length).toBe(MINUTE / 100 + 1);
    // ...and one from before it, so a replay starting a minute back has a pose to start from.
    expect(samples[0]!.t).toBeLessThan(end - MINUTE);
    expect(rec.events.every((e) => e.t >= end - MINUTE - 10_000)).toBe(true);
    expect(rec.events.filter((e) => e.t >= end - MINUTE)).toHaveLength(61);
  });

  it('keeps the highlights that could still be the MVP replay, however old', () => {
    let highlights: Highlight[] = [{ start: 300_000, end: 305_000 }];
    const rec = new ReplayRecorder(() => highlights);
    const end = 20 * MINUTE;
    play(rec, 0, end);
    const samples = rec.tracks.get('a')!.samples;
    // The highlight with the replay's lead-in and lead-out: every pose and event.
    const inWindow = (t: number) => t >= 296_500 && t <= 306_500;
    expect(samples.filter((s) => inWindow(s.t))).toHaveLength(101);
    expect(rec.events.filter((e) => inWindow(e.t))).toHaveLength(10);
    // A pose just before it to start from; nothing else that old.
    const old = samples.filter((s) => s.t < end - MINUTE - 10_000);
    expect(old.length).toBeLessThanOrEqual(103);
    expect(old[0]!.t).toBeLessThan(296_500);

    // A better highlight replaces it: the old one goes at the next trim.
    highlights = [{ start: end + 5_000, end: end + 8_000 }];
    play(rec, end + 100, end + 10_000);
    expect(rec.tracks.get('a')!.samples.filter((s) => inWindow(s.t))).toHaveLength(0);
    expect(rec.events.filter((e) => inWindow(e.t))).toHaveLength(0);
  });

  it('keeps everything while a replay is playing from it', () => {
    const rec = new ReplayRecorder();
    play(rec, 0, 2 * MINUTE);
    rec.hold();
    const first = rec.tracks.get('a')!.samples[0]!.t;
    const events = rec.events.length;
    play(rec, 2 * MINUTE + 100, 3 * MINUTE);
    expect(rec.tracks.get('a')!.samples[0]!.t).toBe(first);
    expect(rec.events.length).toBe(events + 60);
    rec.release();
    play(rec, 3 * MINUTE + 100, 3 * MINUTE + 6_000);
    expect(rec.tracks.get('a')!.samples[0]!.t).toBeGreaterThan(first);
    expect(rec.events.length).toBeLessThan(70);
  });

  it('knows where the flags were at any moment, including before what it trimmed', () => {
    const start: Partial<Record<Team, FlagPlacement>> = { red: { at: 'base' } };
    const highlights: Highlight[] = [{ start: 200_000, end: 204_000 }];
    const rec = new ReplayRecorder(() => highlights);
    rec.reset(start);
    const log: ReplayEvent[] = [];
    const teams: Team[] = ['red', 'blue'];
    // A flag change every 7 s, alternating teams, over 10 minutes of play.
    for (let t = 0, i = 0; t <= 10 * MINUTE; t += 100) {
      rec.pose('a', pose(), t);
      if (t % 7_000 === 0) {
        const team = teams[i % 2]!;
        const placement: FlagPlacement = i % 3 === 0 ? { at: 'base' } : i % 3 === 1 ? { at: 'carried', carrier: 'a' } : { at: 'ground', x: i, y: 0, z: 0 };
        const e: ReplayEvent = { t, kind: 'flag', team, placement };
        rec.event(e);
        log.push(e);
        i++;
      }
    }
    // The answer of a scan through every flag change since the start.
    const scan = (t: number) => {
      const flags = { ...start };
      for (const e of log) if (e.kind === 'flag' && e.t <= t) flags[e.team] = e.placement;
      return flags;
    };
    // Anywhere a replay can start: in the last minute, or at the kept highlight.
    for (let t = 10 * MINUTE - MINUTE; t <= 10 * MINUTE; t += 1_300) expect(rec.flagsAt(t)).toEqual(scan(t));
    for (let t = 196_500; t <= 205_500; t += 500) expect(rec.flagsAt(t)).toEqual(scan(t));
    // Flag changes out of order (a remote one arriving late) still land in the right place.
    rec.event({ t: 10 * MINUTE - 50, kind: 'flag', team: 'blue', placement: { at: 'base' } });
    rec.event({ t: 10 * MINUTE - 80, kind: 'flag', team: 'blue', placement: { at: 'carried', carrier: 'b' } });
    expect(rec.flagsAt(10 * MINUTE - 60).blue).toEqual({ at: 'carried', carrier: 'b' });
    expect(rec.flagsAt(10 * MINUTE).blue).toEqual({ at: 'base' });
  });
});
