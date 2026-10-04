import { useEffect, useState } from 'react';
import { isConfigured } from '../net/firebase';
import { watchEntry, watchLeaderboard, type LeaderboardEntry } from '../net/leaderboard';

const MEDALS = ['🥇', '🥈', '🥉'];

/** Live top players, best first; `null` while loading. */
function useLeaderboard(limit: number): { entries: LeaderboardEntry[] | null; failed: boolean } {
  const [entries, setEntries] = useState<LeaderboardEntry[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!isConfigured) return;
    return watchLeaderboard(limit, (list) => {
      setFailed(false);
      setEntries(list);
    }, () => setFailed(true));
  }, [limit]);
  return { entries, failed };
}

/** Our own totals, for when we're not in the top list. */
function useOwnEntry(me: string): LeaderboardEntry | null {
  const [entry, setEntry] = useState<LeaderboardEntry | null>(null);
  useEffect(() => (isConfigured ? watchEntry(me, setEntry) : undefined), [me]);
  return entry;
}

const kd = (e: LeaderboardEntry) => (e.deaths ? e.kills / e.deaths : e.kills).toFixed(2);

/** The global ranking, as shown in the lobby. `me` highlights the player's own row. */
export function Leaderboard({ limit = 20, me }: { limit?: number; me: string }) {
  const { entries, failed } = useLeaderboard(limit);
  const own = useOwnEntry(me);
  const outside = own && entries && !entries.some((e) => e.id === me) ? own : null;
  return (
    <div className="leaderboard">
      <h2>Top {limit} players</h2>
      {!isConfigured ? (
        <p className="empty">Not connected to Firebase</p>
      ) : failed ? (
        <p className="empty">Couldn't load the leaderboard</p>
      ) : entries === null ? (
        <p className="empty"><span className="spinner" aria-hidden="true" />Loading…</p>
      ) : entries.length === 0 ? (
        <p className="empty">No ranked players yet — finish a round to get on the board.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th scope="col">#</th>
              <th scope="col" className="name">Player</th>
              <th scope="col" title="Kills × 10 + captures × 30 + wins × 50">Score</th>
              <th scope="col">K/D</th>
              <th scope="col">Wins</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e, i) => (
              <tr key={e.id} className={e.id === me ? 'me' : undefined}>
                <td className="rank">{MEDALS[i] ?? i + 1}</td>
                <td className="name">{e.name}{e.id === me && <span className="you"> (you)</span>}</td>
                <td className="score">{e.score.toLocaleString()}</td>
                <td title={`${e.kills} kills · ${e.deaths} deaths`}>{kd(e)}</td>
                <td>{e.wins}</td>
              </tr>
            ))}
          </tbody>
          {outside && (
            <tfoot>
              <tr className="me">
                <td className="rank" title={`Not in the top ${limit} yet`}>–</td>
                <td className="name">{outside.name}<span className="you"> (you)</span></td>
                <td className="score">{outside.score.toLocaleString()}</td>
                <td title={`${outside.kills} kills · ${outside.deaths} deaths`}>{kd(outside)}</td>
                <td>{outside.wins}</td>
              </tr>
            </tfoot>
          )}
        </table>
      )}
      <p className="muted hint">Score: kills × 10, captures × 30, wins × 50. Every finished round counts.</p>
    </div>
  );
}
