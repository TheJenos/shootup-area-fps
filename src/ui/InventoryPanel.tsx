import type { Game } from '../game/game';
import { ABILITIES, type SlotView } from '../game/abilities';
import { keyLabel } from '../game/settings';
import { useSettings } from './SettingsPanel';

interface Props {
  game: Game;
  slots: (SlotView | null)[];
}

/** Opened with I: shows what's in each slot and lets the player drop it. */
export function InventoryPanel({ game, slots }: Props) {
  const { bindings } = useSettings();
  const slotKeys = [bindings.ability1, bindings.ability2, bindings.ability3].map(keyLabel);
  return (
    <div id="inventory" className="overlay">
      <div className="panel-box">
        <header>
          <h3>Inventory</h3>
          <span className="muted"><kbd>{keyLabel(bindings.inventory)}</kbd> back to game · <kbd>Esc</kbd> close</span>
        </header>

        <div className="items">
          {slots.map((slot, i) => (
            <div key={i} className={`item ${slot ? '' : 'empty'}`}>
              <kbd className="key">{slotKeys[i]}</kbd>
              {slot ? <ItemDetails slot={slot} /> : <p className="muted">Empty slot</p>}
              <button className="danger" disabled={!slot} onClick={() => game.dropAbility(i)}>
                Drop
              </button>
            </div>
          ))}
        </div>

        <p className="muted hint">Dropped abilities keep their remaining uses, and anyone can pick them up.</p>
      </div>
    </div>
  );
}

function ItemDetails({ slot }: { slot: SlotView }) {
  const def = ABILITIES[slot.type];
  return (
    <>
      <span className="icon">{def.icon}</span>
      <strong>{def.name}</strong>
      <span className="muted desc">{def.description}</span>
      <div className="facts">
        <span>
          <span className="uses">
            {Array.from({ length: def.uses }, (_, u) => <i key={u} className={u < slot.usesLeft ? 'left' : undefined} />)}
          </span>
          {slot.usesLeft} / {def.uses} uses
        </span>
        <span className={slot.cooldown > 0 ? 'cooling' : 'ready'}>
          {slot.cooldown > 0 ? `Cooldown ${slot.cooldown.toFixed(1)}s` : 'Ready'}
        </span>
        <span className="muted">{def.cooldown}s cooldown</span>
      </div>
    </>
  );
}
