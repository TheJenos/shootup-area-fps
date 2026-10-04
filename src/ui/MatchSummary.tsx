import { useEffect, useState } from 'react';
import type { MatchInfo, MyMatch, ScoreRow, ScoreView } from '../game/hudStore';
import { MODES, TEAMS, TEAM_INFO } from '../game/modes';
import type { GameMode } from '../types';
import { safeColor } from './colors';

function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

const percent = (n: number | null) => (n === null ? '—' : `${Math.round(n * 100)}%`);
const kd = (k: number, d: number) => (d ? (k / d).toFixed(2) : k.toFixed(2));

/** Ticks once a second while mounted. */
function useNow(): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}

interface Props {
  roomCode: string;
  match: MatchInfo | null;
  rows: ScoreRow[];
  myMatch: MyMatch;
  mode: GameMode;
  score: ScoreView;
  map: { name: string; seed: string } | null;
}

/** Held open with Tab: everyone's stats plus your own match summary. */
export function MatchSummary({ roomCode, match, rows, myMatch, mode, score, map }: Props) {
  const now = useNow();
  const me = rows.find((r) => r.me);
  const leader = rows[0];
  const { teams } = MODES[mode];
  const ctf = mode === 'ctf';
  const columns = ctf ? 10 : 9;
  // Team modes list each team under its own header; FFA is one list.
  const groups = teams
    ? TEAMS.map((t) => ({ team: t, rows: rows.filter((r) => r.team === t) }))
    : [{ team: null, rows }];

  const row = (r: ScoreRow, i: number) => (
    <tr key={r.id} className={r.me ? 'me' : undefined}>
      <td className="rank">{i + 1}</td>
      <td className="player">
        <span className="dot" style={{ background: safeColor(r.color) }} />
        {r.name}
        {r === leader && (r.kills > 0 || r.captures > 0) && <span className="crown" title="Top player">👑</span>}
      </td>
      {ctf && <td>{r.captures}</td>}
      <td>{r.kills}</td>
      <td>{r.deaths}</td>
      <td>{kd(r.kills, r.deaths)}</td>
      <td>{r.damage}</td>
      <td>{percent(r.accuracy)}</td>
      <td>{r.headshots}</td>
      <td>{r.bestStreak}</td>
    </tr>
  );

  return (
    <div id="match-summary">
      <header>
        <div>
          <h3>{match?.roomName ?? 'Match'}</h3>
          <span className="muted">
            {MODES[mode].name} · first to {MODES[mode].limit} ·{' '}
            {map && <>{map.name} (seed {map.seed}) · </>}Room {roomCode} · {rows.length}{' '}
            {rows.length === 1 ? 'player' : 'players'}
          </span>
        </div>
        {teams && (
          <div className="team-score">
            <strong style={{ color: TEAM_INFO.red.color }}>{score.red}</strong>
            <span className="muted">–</span>
            <strong style={{ color: TEAM_INFO.blue.color }}>{score.blue}</strong>
          </div>
        )}
        <div className="clock">
          <span className="muted">Match time</span>
          <strong>{match ? formatClock(now - match.startedAt) : '—'}</strong>
        </div>
      </header>

      <table>
        <thead>
          <tr>
            <th className="rank">#</th>
            <th>Player</th>
            {ctf && <th>Caps</th>}
            <th>K</th>
            <th>D</th>
            <th>K/D</th>
            <th>Damage</th>
            <th>Acc.</th>
            <th>HS</th>
            <th>Best streak</th>
          </tr>
        </thead>
        {groups.map((g) => (
          <tbody key={g.team ?? 'all'}>
            {g.team && (
              <tr className={`team-row ${g.team}`}>
                <td colSpan={columns} style={{ color: TEAM_INFO[g.team].color }}>
                  {TEAM_INFO[g.team].name} team · {score[g.team]} {ctf ? 'capture' : 'kill'}{score[g.team] === 1 ? '' : 's'}
                  {g.rows.length === 0 && <span className="muted"> · nobody yet</span>}
                </td>
              </tr>
            )}
            {g.rows.map(row)}
          </tbody>
        ))}
      </table>

      {me && (
        <section className="mine">
          <h4>Your match</h4>
          <div className="stats">
            <Stat label="Place" value={`${rows.indexOf(me) + 1} / ${rows.length}`} />
            {ctf ? <Stat label="Captures" value={me.captures} /> : <Stat label="Kills" value={me.kills} />}
            <Stat label="Damage" value={me.damage} />
            <Stat label="Accuracy" value={percent(me.accuracy)} />
            <Stat label="Headshots" value={me.headshots} />
            <Stat label="Best streak" value={me.bestStreak} />
            <Stat label="Pickups" value={myMatch.pickups} />
            <Stat label="Abilities used" value={myMatch.abilitiesUsed} />
          </div>
        </section>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="stat">
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}
