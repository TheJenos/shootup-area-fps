import type { Game } from '../game/game';
import { ABILITIES, type SlotView } from '../game/abilities';
import { GUNS } from '../game/guns';
import type { GunKind } from '../types';
import { keyLabel } from '../game/settings';
import { useSettings } from './SettingsPanel';

interface Props {
  game: Game;
  slots: (SlotView | null)[];
  /** The picked-up gun and its rounds left, if any */
  gun: GunKind | null;
  gunRounds: number | null;
}

/** Opened with I: shows the picked-up gun and each ability slot, and lets the player drop them. */
export function InventoryPanel({ game, slots, gun, gunRounds }: Props) {
  const { bindings } = useSettings();
  const slotKeys = [bindings.ability1, bindings.ability2, bindings.ability3].map(keyLabel);
  return (
    <div id="inventory" className="overlay">
      <div className="panel-box">
        <header>
          <h3>Inventory</h3>
          {game.touch ? (
            <button type="button" onClick={() => game.closeInventory(true)}>Close</button>
          ) : (
            <span className="muted"><kbd>{keyLabel(bindings.inventory)}</kbd> back to game · <kbd>Esc</kbd> close</span>
          )}
        </header>

        <div className={`gun-row ${gun ? '' : 'empty'}`}>
          {gun ? (
            <>
              <span className="icon">{GUNS[gun].icon}</span>
              <div>
                <strong>{GUNS[gun].name}</strong>
                <span className="muted desc">{GUNS[gun].description} · {gunRounds ?? 0} rounds left</span>
              </div>
            </>
          ) : (
            <p className="muted">No picked-up gun — walk over one on the map to take it.</p>
          )}
          <button className="danger" disabled={!gun} onClick={() => game.dropGun()}>Drop</button>
        </div>

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

        <p className="muted hint">You can carry one picked-up gun: drop it to take a different one. Dropped items keep their ammo or
          uses, and anyone can pick them up.</p>
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
