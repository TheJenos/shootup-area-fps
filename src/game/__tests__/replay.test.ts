import { describe, expect, it } from 'vitest';
import { ReplayRecorder } from '../replay';

const pose = (gun?: 'rifle' | 'shotgun' | 'sniper') => ({ name: 'Kai', color: '#fff', x: 0, y: 0, z: 0, yaw: 0, pitch: 0, alive: true, ...(gun ? { gun } : {}) });

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
});
