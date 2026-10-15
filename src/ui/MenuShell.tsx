import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import { Brand } from './Brand';
import { MenuBackdrop } from './MenuBackdrop';

/*
 * The lobby's frame, as a game's main menu: a fly-over of a map behind everything (MenuBackdrop), the
 * brand and who you're playing as along the top, a rail of big menu entries down the left (the main
 * action first, then the views, then extras and settings), and the chosen view in a panel on the right.
 * Phones stack the rail above the panel. Shared by the lobby and the Discord lobby; the pause menu and
 * Settings use the rail's pieces too, so every menu in the game reads the same way.
 */

export interface MenuTab {
  id: string;
  label: string;
  /** What phones show instead (their tabs sit in a row) */
  short?: string;
  /** A line under the label */
  sub?: string;
  icon: string;
  /** A count badge (e.g. open rooms) */
  count?: number;
}

/**
 * The whole screen: backdrop, top bar and whatever goes in the middle. With `onSettings`, a footer with
 * Settings and the legal links: under the rail, or at the very bottom on phones.
 */
export function MenuFrame({ profile, discord, onSettings, backdropDelay, children }: {
  profile?: ReactNode; discord?: boolean; onSettings?(): void;
  /** Hold the backdrop back this long (ms), e.g. while an invite counts down to joining */
  backdropDelay?: number;
  children: ReactNode;
}) {
  return (
    <section id="lobby" className={discord ? 'screen menu discord' : 'screen menu'}>
      <MenuBackdrop delay={backdropDelay} />
      <header className="menu-top">
        <Brand />
        {profile}
      </header>
      <div className="menu-body">
        {children}
        {onSettings && (
          <footer className="menu-foot">
            <button type="button" className="menu-settings" onClick={onSettings}>
              <span className="icon" aria-hidden="true">⚙</span>Settings
            </button>
            <p className="legal muted">
              <a href="/terms.html" target="_blank" rel="noreferrer">Terms</a> · <a href="/privacy.html" target="_blank" rel="noreferrer">Privacy</a> · <a href="/credits.html" target="_blank" rel="noreferrer">Credits</a>
            </p>
          </footer>
        )}
      </div>
    </section>
  );
}

/** Who you're playing as (top right) */
export function ProfileChip({ name, title }: { name: string; title: string }) {
  return (
    <div className="lobby-profile" title={title}>
      <span className="avatar" aria-hidden="true"><span>{name.slice(0, 1).toUpperCase()}</span></span>
      <span className="who">
        <span className="muted">Playing as</span>
        <strong>{name}</strong>
      </span>
    </div>
  );
}

interface TabsProps {
  tabs: MenuTab[];
  active: string;
  onSelect(id: string): void;
  /** What the list is, for screen readers */
  label: string;
  /** Before the tabs' and panels' ids, where two lists could share a page (e.g. 'settings-') */
  idPrefix?: string;
}

/**
 * Views as a vertical tab list of big entries: arrow keys move between them (and show each, as tabs
 * do), Home / End jump to the ends. Each tab is named by its label; the line under it describes it.
 * Phones lay them in a row and show the short labels.
 */
export function MenuTabs({ tabs, active, onSelect, label, idPrefix = '' }: TabsProps) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = tabs.findIndex((t) => t.id === active);
    const next = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? i + 1
      : e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? i - 1
        : e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : null;
    if (next === null) return;
    e.preventDefault();
    const k = (next + tabs.length) % tabs.length;
    onSelect(tabs[k]!.id);
    refs.current[k]?.focus();
  };
  return (
    <div className="menu-tabs" role="tablist" aria-label={label} aria-orientation="vertical" onKeyDown={onKey}>
      {tabs.map((t, i) => {
        const id = `${idPrefix}tab-${t.id}`;
        const described = [t.sub && `${id}-sub`, t.count !== undefined && `${id}-count`].filter(Boolean).join(' ');
        return (
          <button
            key={t.id}
            ref={(el) => { refs.current[i] = el; }}
            type="button"
            role="tab"
            id={id}
            aria-selected={active === t.id}
            aria-controls={`${idPrefix}panel-${t.id}`}
            aria-labelledby={`${id}-label`}
            aria-describedby={described || undefined}
            tabIndex={active === t.id ? 0 : -1}
            className={active === t.id ? 'menu-tab selected' : 'menu-tab'}
            onClick={() => onSelect(t.id)}
          >
            <span className="icon" aria-hidden="true">{t.icon}</span>
            <span className="text">
              <span className="label" id={`${id}-label`}>{t.label}</span>
              {t.short && <span className="short" aria-hidden="true">{t.short}</span>}
              {t.sub && <span className="sub" id={`${id}-sub`}>{t.sub}</span>}
            </span>
            {t.count !== undefined && <span className="count" id={`${id}-count`} aria-label={`${t.count} open`}>{t.count}</span>}
          </button>
        );
      })}
    </div>
  );
}

interface RailProps {
  /** The main action, above the views (e.g. Play now) */
  hero?: ReactNode;
  tabs: MenuTab[];
  active: string;
  onSelect(id: string): void;
  /** Under the views (e.g. joining by code) */
  extra?: ReactNode;
  /** The rail's name, and its views' */
  label?: string;
  tabsLabel?: string;
  idPrefix?: string;
}

/** The menu entries: the main action, the views (MenuTabs), then whatever else goes on the rail. */
export function MenuRail({ hero, tabs, active, onSelect, extra, label = 'Main menu', tabsLabel = 'Lobby', idPrefix }: RailProps) {
  return (
    <nav className="menu-rail" aria-label={label}>
      {hero}
      <MenuTabs tabs={tabs} active={active} onSelect={onSelect} label={tabsLabel} idPrefix={idPrefix} />
      {extra}
    </nav>
  );
}

/**
 * The chosen view, in the panel on the right (the tab panel for `id`'s tab). Without a `title` the view
 * brings its own heading.
 */
export function MenuPanel({ id, title, aside, idPrefix = '', children }: {
  id: string; title?: ReactNode; aside?: ReactNode; idPrefix?: string; children: ReactNode;
}) {
  return (
    <section id={`${idPrefix}panel-${id}`} role="tabpanel" aria-labelledby={`${idPrefix}tab-${id}`} className={`menu-panel panel-${id}`}>
      {title && (
        <header className="menu-panel-head">
          <h2>{title}</h2>
          {aside}
        </header>
      )}
      <div className="menu-panel-body">{children}</div>
    </section>
  );
}
