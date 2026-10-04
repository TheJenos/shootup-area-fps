import { useSettings } from './SettingsPanel';

/** The crosshair, in the player's colour and size. `ads` shrinks it to a dot while aiming. */
export function Crosshair({ ads = false }: { ads?: boolean }) {
  const { crosshairColor, crosshairSize } = useSettings();
  return (
    <div
      id="crosshair"
      className={ads ? 'ads' : undefined}
      style={{ '--ch': crosshairColor, '--ch-size': crosshairSize } as React.CSSProperties}
    />
  );
}
