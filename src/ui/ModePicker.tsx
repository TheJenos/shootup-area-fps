import { BOT_SKILL_OPTIONS, LIMITS, tweaks, type ModeRules } from '../game/rules';

/* What's left of the old mode picker: a mode's facts in a few words, and the new room's bots (the
   modes themselves are picked in ModeGrid, and built in ModeEditor). */

/** The facts about a mode worth a glance: what wins it, how long, and what's different */
export function modeFacts(value: ModeRules): string[] {
  const unit = value.base === 'ctf' ? 'captures' : value.base === 'snd' ? 'rounds' : value.loadout === 'gungame' ? 'guns' : 'kills';
  if (value.base === 'hrd') return ['Co-op against zombie bots', `${value.limit} waves to win`, 'The fallen are back after each wave', ...tweaks(value)];
  if (value.base === 'inf') return [`${value.limit} zombie${value.limit === 1 ? '' : 's'} at the start`, `Survive ${value.minutes} min`, 'The dead turn', ...tweaks(value)];
  return [`${value.limit} ${unit} to win`, `${value.minutes} min`, ...(value.base === 'snd' ? ['One life per round'] : []), ...tweaks(value)];
}

/** How many bots a new room starts with, and how good they are */
export function BotsField({ value, onChange }: { value: ModeRules; onChange(rules: ModeRules): void }) {
  return (
    <div className="mode-bots" role="group" aria-label="Bots">
      <label className="setting">
        <span>Bots</span>
        <input type="range" min={LIMITS.bots[0]} max={LIMITS.bots[1]} step={1} value={value.bots} aria-label="Start with bots"
          onChange={(e) => onChange({ ...value, bots: Number(e.target.value) })} />
        <span className="number-readout">{value.bots ? `${value.bots} bot${value.bots === 1 ? '' : 's'}` : 'None'}</span>
      </label>
      {value.bots > 0 && (
        <label className="setting">
          <span>Bot skill</span>
          <select value={value.botSkill} aria-label="Bot skill" onChange={(e) => onChange({ ...value, botSkill: e.target.value as ModeRules['botSkill'] })}>
            {BOT_SKILL_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </label>
      )}
      <p className="muted hint">Add more, at any level, from the pause menu while you play.</p>
    </div>
  );
}
