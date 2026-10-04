import type { Moment } from '../types';

/** Kills count as one chain while each comes within this long of the previous one (ms). */
const CHAIN_GAP = 4_000;
/** Long streaks replay only their last stretch (ms). */
const STREAK_WINDOW = 8_000;
const MIN_STREAK = 5;

const CHAIN_NAMES: Record<number, string> = { 2: 'Double Kill', 3: 'Triple Kill', 4: 'Quad Kill' };

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

/**
 * Tracks this player's best highlight of the round, which is published so the round's
 * MVP can be picked. Every time is server ms, so the replay can find the moment.
 *
 * | Highlight                                  | Score                      |
 * | ------------------------------------------ | -------------------------- |
 * | n kills, each within 4 s of the last       | 10 · n²                    |
 * | Flag capture                               | 60 + 25 per kill carrying  |
 * | Killing the enemy flag carrier             | 35                         |
 * | Streak of 5+ without dying                 | 8 per kill                 |
 * | Any kill (headshot)                        | 5 (15)                     |
 */
export class MomentTracker {
  private best: Moment | null = null;
  private chain: number[] = [];
  private streak: number[] = [];

  reset(): void {
    this.best = null;
    this.chain = [];
    this.streak = [];
  }

  get(): Moment | null {
    return this.best;
  }

  onKill(t: number, opts: { head: boolean; stoppedCarrier: boolean }): void {
    const last = this.chain[this.chain.length - 1];
    this.chain = last !== undefined && t - last <= CHAIN_GAP ? [...this.chain, t] : [t];
    this.streak.push(t);

    this.offer({ score: opts.head ? 15 : 5, title: opts.head ? 'Headshot' : 'Clean kill', start: t, end: t });
    const n = this.chain.length;
    if (n >= 2) {
      const start = this.chain[0] ?? t;
      const name = CHAIN_NAMES[n] ?? `Rampage: ${n} kills`;
      this.offer({ score: 10 * n * n, title: `${name} in ${seconds(t - start)}`, start, end: t });
    }
    if (opts.stoppedCarrier) this.offer({ score: 35, title: 'Stopped the flag carrier', start: t, end: t });
    const s = this.streak.length;
    if (s >= MIN_STREAK) {
      const recent = this.streak.filter((k) => t - k <= STREAK_WINDOW);
      this.offer({ score: 8 * s, title: `${s}-kill streak`, start: recent[0] ?? t, end: t });
    }
  }

  onDeath(): void {
    this.chain = [];
    this.streak = [];
  }

  /** @param takenAt when we grabbed the flag; the replay covers at most the last 8 s of the run */
  onCapture(t: number, takenAt: number, killsWhileCarrying: number): void {
    const title = killsWhileCarrying > 0
      ? `Flag run + ${killsWhileCarrying} kill${killsWhileCarrying === 1 ? '' : 's'}`
      : 'Flag capture';
    this.offer({ score: 60 + 25 * killsWhileCarrying, title, start: Math.max(takenAt, t - STREAK_WINDOW), end: t });
  }

  private offer(moment: Moment): void {
    if (!this.best || moment.score > this.best.score) this.best = moment;
  }
}
