import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HudStore } from '../hudStore';

describe('HudStore announcements', () => {
  let hud: HudStore;
  beforeEach(() => {
    vi.useFakeTimers();
    hud = new HudStore();
  });
  afterEach(() => {
    hud.dispose();
    vi.useRealTimers();
  });

  const showing = () => hud.get().announce?.text ?? null;

  it('clears a banner after its lifetime', () => {
    hud.announce('BOMB PLANTED');
    expect(showing()).toBe('BOMB PLANTED');
    vi.advanceTimersByTime(2_200);
    expect(showing()).toBeNull();
  });

  it('lets an objective banner replace a minor one', () => {
    hud.announceMinor('DOUBLE KILL');
    hud.announce('YOUR FLAG IS GONE');
    expect(showing()).toBe('YOUR FLAG IS GONE');
  });

  it('holds a minor banner back until the objective one ends', () => {
    hud.announce('BOMB PLANTED');
    vi.advanceTimersByTime(500);
    hud.announceMinor('DOUBLE KILL');
    expect(showing()).toBe('BOMB PLANTED');
    vi.advanceTimersByTime(1_700);
    expect(showing()).toBe('DOUBLE KILL');
    vi.advanceTimersByTime(2_200);
    expect(showing()).toBeNull();
  });

  it('drops a held minor banner once it is stale', () => {
    hud.announce('OVERTIME', '', 3_500);
    vi.advanceTimersByTime(200);
    hud.announceMinor('DOUBLE KILL');
    vi.advanceTimersByTime(3_300);
    expect(showing()).toBeNull();
  });

  it('keeps only the latest held minor banner, and drops it when another objective one arrives', () => {
    hud.announce('BOMB PLANTED');
    hud.announceMinor('DOUBLE KILL');
    hud.announceMinor('TRIPLE KILL');
    vi.advanceTimersByTime(2_200);
    expect(showing()).toBe('TRIPLE KILL');

    hud.announce('ROUND WON');
    hud.announceMinor('QUAD KILL');
    hud.announce('BOMB DEFUSED');
    vi.advanceTimersByTime(2_200);
    expect(showing()).toBeNull();
  });

  it('lets minor banners replace each other', () => {
    hud.announceMinor('DOUBLE KILL');
    hud.announceMinor('TRIPLE KILL');
    expect(showing()).toBe('TRIPLE KILL');
  });
});
