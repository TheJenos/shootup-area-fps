import { describe, expect, it } from 'vitest';
import { BOT_NAMES, botName, pickBase, startingRoster, rosterEntries } from '../roster';
import { BOT_SKILLS } from '../brain';

describe('the bot list', () => {
  it('names a bot with its level, always within the 16-character name limit', () => {
    expect(botName({ base: 'Kai', skill: 'hard' })).toBe('Kai [Hard]');
    expect(botName({ base: 'Echo', skill: 'expert' })).toBe('Echo [Expert]');
    for (const base of BOT_NAMES) for (const skill of BOT_SKILLS) expect(botName({ base, skill }).length).toBeLessThanOrEqual(16);
    for (const base of BOT_NAMES) expect(base.length).toBeLessThanOrEqual(8);
  });

  it('picks names nobody is using, levels or not', () => {
    const taken = BOT_NAMES.slice(0, -1).map((b) => `${b} [Normal]`);
    expect(pickBase(taken)).toBe(BOT_NAMES[BOT_NAMES.length - 1]);
  });

  it('starts a room with the asked-for bots, all different, in order', () => {
    const roster = startingRoster(5, 'hard', 1000);
    const entries = rosterEntries(roster);
    expect(entries).toHaveLength(5);
    expect(new Set(entries.map(([, s]) => s.base)).size).toBe(5);
    expect(entries.every(([, s]) => s.skill === 'hard')).toBe(true);
    expect(entries.map(([, s]) => s.at)).toEqual([1000, 1001, 1002, 1003, 1004]);
    expect(Object.keys(startingRoster(40, 'easy', 0))).toHaveLength(12);
  });
});
