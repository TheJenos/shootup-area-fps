import { useEffect, useState } from 'react';
import { isConfigured } from '../net/firebase';
import {
  GLOBAL_BOARD, isGuildId, watchEntry, watchLeaderboard, type BoardScope, type LeaderboardEntry,
} from '../net/leaderboard';

const MEDALS = ['🥇', '🥈', '🥉'];

/** Live top players, best first; `null` while loading. */
function useLeaderboard(scope: BoardScope, limit: number): { entries: LeaderboardEntry[] | null; failed: boolean } {
  const [entries, setEntries] = useState<LeaderboardEntry[] | null>(null);
  const [failed, setFailed] = useState(false);
  const key = scope.kind === 'global' ? 'global' : scope.guildId;
  useEffect(() => {
    if (!isConfigured) return;
    setEntries(null);
    setFailed(false);
    return watchLeaderboard(scope, limit, (list) => {
      setFailed(false);
      setEntries(list);
    }, () => setFailed(true));
    // `key` stands for the scope (a new object each render)
  }, [key, limit]);
  return { entries, failed };
}

/** Our own totals, for when we're not in the top list. */
function useOwnEntry(scope: BoardScope, me: string): LeaderboardEntry | null {
  const [entry, setEntry] = useState<LeaderboardEntry | null>(null);
  const key = scope.kind === 'global' ? 'global' : scope.guildId;
  useEffect(() => {
    setEntry(null);
    return isConfigured ? watchEntry(scope, me, setEntry) : undefined;
    // `key` stands for the scope (a new object each render)
  }, [key, me]);
  return entry;
}

const kd = (e: LeaderboardEntry) => (e.deaths ? e.kills / e.deaths : e.kills).toFixed(2);

/**
 * The rankings, as shown in the lobby: the global board and, inside a Discord server, a switch to
 * that server's own board. `me` highlights the player's own row.
 */
export function Leaderboard({ limit = 20, me, guildId }: { limit?: number; me: string; guildId?: string | null }) {
  const guild = isGuildId(guildId) ? guildId : null;
  const [which, setWhich] = useState<'global' | 'guild'>(guild ? 'guild' : 'global');
  const scope: BoardScope = which === 'guild' && guild ? { kind: 'guild', guildId: guild } : GLOBAL_BOARD;
  const { entries, failed } = useLeaderboard(scope, limit);
  const own = useOwnEntry(scope, me);
  const outside = own && entries && !entries.some((e) => e.id === me) ? own : null;
  const onServer = scope.kind === 'guild';
  return (
    <div className="leaderboard">
      <div className="board-head">
        <h2>{onServer ? `Top ${limit} on this server` : `Top ${limit} players`}</h2>
        {guild && (
          <div className="board-switch" role="group" aria-label="Which leaderboard">
            <button type="button" aria-pressed={which === 'global'} onClick={() => setWhich('global')}>🌍 Global</button>
            <button type="button" aria-pressed={which === 'guild'} onClick={() => setWhich('guild')}>🏠 This server</button>
          </div>
        )}
      </div>
      {!isConfigured ? (
        <p className="empty">Not connected to Firebase</p>
      ) : failed ? (
        <p className="empty">Couldn't load the leaderboard</p>
      ) : entries === null ? (
        <p className="empty"><span className="spinner" aria-hidden="true" />Loading…</p>
      ) : entries.length === 0 ? (
        <p className="empty">
          {onServer ? 'Nobody on this server is ranked yet — finish a round here to get on the board.' : 'No ranked players yet — finish a round to get on the board.'}
        </p>
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
      <p className="muted hint">
        Score: kills × 10, captures × 30, wins × 50.{' '}
        {onServer ? 'Rounds played in this server count here (and globally).' : 'Every finished round counts.'}
      </p>
    </div>
  );
}
