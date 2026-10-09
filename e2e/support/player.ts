import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test';

/*
 * One player: a browser context of their own (own localStorage, so own name and profile) with a page
 * on the game. Wraps the lobby steps and `window.game.test` (src/game/game.ts) for the match ones.
 */

type Vec3 = [number, number, number];

/** What `window.game.test.state()` returns */
export interface GameStateView {
  id: string;
  hp: number;
  alive: boolean;
  kills: number;
  deaths: number;
  team: 'red' | 'blue' | null;
  locked: boolean;
  spectating: boolean;
  killcam: boolean;
  leader: boolean;
  pos: Vec3;
  yaw: number;
  onGround: boolean;
  /** Horizontal speed, m/s */
  speed: number;
  stance: 'stand' | 'crouch' | 'slide';
  gun: string;
  special: string | null;
  ammo: number;
  reserve: number | null;
  carryingFlag: boolean;
  /** Search & Destroy: carrying the bomb, planting or defusing, and the defenders' sites this round */
  carryingBomb: boolean;
  channel: { kind: 'plant' | 'defuse'; t: number } | null;
  sites: Record<'a' | 'b', { x: number; y: number; z: number }> | null;
  shield: number;
  slots: (string | null)[];
  mapSeed: string;
  mapSize: 's' | 'm' | 'l';
  mapGen: number;
  /** Fingerprint of the map this client built (null before one is built) */
  mapHash: number | null;
  game: {
    round: number;
    seed?: string;
    startedAt?: number;
    score: Partial<Record<'red' | 'blue', number>>;
    flags: Partial<Record<'red' | 'blue', { by?: string; x?: number; y?: number; z?: number }>>;
    ended?: { winner: string; name: string; reason: 'time' | 'score'; at?: number };
    snd?: {
      n: number;
      atk: 'red' | 'blue';
      at: number;
      bomb: { by?: string; x?: number; y?: number; z?: number; site?: 'a' | 'b'; plantedAt?: number; planter?: string };
      over?: { winner: 'red' | 'blue'; why: 'elim' | 'bomb' | 'defuse' | 'time'; at: number };
    };
  };
  rules: Record<string, unknown>;
}

export const SETTINGS = {
  // (The kill cam is off: tests expect the death screen straight away; killcam.spec turns it on.)
  fullscreen: false, quality: 'low', sfxVolume: 0, musicVolume: 0, screenShake: false, showFps: false, killcam: false, version: 2,
};
const HINTS = ['slide', 'gun-swap', 'ads', 'full-slots', ...[
  'medkit', 'shield', 'speed', 'dash', 'grenade', 'smoke', 'wall', 'cloak', 'scan', 'molotov', 'flash', 'turret', 'mine', 'lifesteal',
].map((a) => `ability:${a}`)];

export interface PlayerOptions {
  /** Skip the first-visit name prompt with this name; null shows the prompt */
  name: string | null;
  /** Touch-screen player (`?touch` is added to every URL by gotoLobby) */
  touch?: boolean;
  viewport?: { width: number; height: number };
  /** Keep the one-time tips (they're silenced by default so they don't cover other toasts) */
  hints?: boolean;
}

export class Player {
  private constructor(readonly context: BrowserContext, readonly page: Page, readonly name: string, readonly touch: boolean) {}

  static async open(browser: Browser, opts: PlayerOptions): Promise<Player> {
    const context = await browser.newContext({
      viewport: opts.viewport ?? { width: 960, height: 540 },
      ...(opts.touch ? { hasTouch: true, isMobile: false } : {}),
      permissions: ['clipboard-read', 'clipboard-write'],
    });
    // Only seed what isn't there yet, so a test can change settings and reload.
    await context.addInitScript(({ name, settings, hints, touch }) => {
      const seed = (k: string, v: string) => { if (localStorage.getItem(k) === null) localStorage.setItem(k, v); };
      if (name) seed('fps-name', name);
      seed('fps-settings', JSON.stringify(settings));
      if (hints) seed('fps-hints', JSON.stringify(hints));
      if (!touch) seed('fps-touch-intro', '1');
    }, { name: opts.name, settings: SETTINGS, hints: opts.hints ? null : HINTS, touch: !!opts.touch });
    // Sounds are only noise here: answer with nothing instead of downloading ~60 files per player.
    await context.route('**/sounds/*.mp3', (route) => route.fulfill({ status: 200, contentType: 'audio/mpeg', body: '' }));
    const page = await context.newPage();
    page.on('pageerror', (err) => console.log(`[${opts.name ?? 'new player'}] page error: ${err.message}`));
    return new Player(context, page, opts.name ?? '', !!opts.touch);
  }

  // ---------------------------------------------------------------- lobby

  async gotoLobby(query = ''): Promise<void> {
    const q = new URLSearchParams(query);
    if (this.touch) q.set('touch', '');
    const qs = q.toString().replace(/=(&|$)/g, '$1');
    await this.page.goto(`/${qs ? `?${qs}` : ''}`);
    await expect(this.page.locator('#lobby')).toBeVisible();
  }

  /** Join a room with the code box on the Open rooms tab, and wait until we're in the match. */
  async joinByCode(code: string): Promise<void> {
    await this.page.getByRole('tab', { name: /Open rooms/ }).click();
    await this.page.getByLabel('Room code').fill(code);
    await this.page.locator('form.code-join').getByRole('button', { name: 'Join' }).click();
    await this.waitJoined();
  }

  /** Create a room from the Create room tab with a preset mode (by its name) and return its code. */
  async createRoom(opts: { mode?: string | RegExp; seed?: string; size?: 'Small' | 'Medium' | 'Large'; roomName?: string } = {}): Promise<string> {
    const page = this.page;
    await page.getByRole('tab', { name: 'Create room' }).click();
    if (opts.mode) await page.getByRole('radio', { name: opts.mode }).first().click();
    await page.getByLabel('Map seed').fill(opts.seed ?? 'classic');
    if (opts.size) await page.getByRole('radiogroup', { name: 'Map size' }).getByRole('radio', { name: opts.size }).click();
    if (opts.roomName !== undefined) await page.getByLabel('Room name').fill(opts.roomName);
    await page.locator('button.create-button').click();
    await this.waitJoined();
    return this.roomCode();
  }

  async roomCode(): Promise<string> {
    return (await this.page.locator('#room-tag strong').innerText()).trim();
  }

  // ---------------------------------------------------------------- match

  /** In the room: assets loaded and our player record written. */
  async waitJoined(): Promise<void> {
    await this.page.waitForFunction(() => (window as any).game?.joined === true, null, { timeout: 90_000 });
    await expect(this.page.locator('#connecting-overlay')).toBeHidden();
  }

  /** Start playing (what clicking into the game does where pointer lock works). */
  async play(): Promise<void> {
    await expect.poll(() => this.page.evaluate(() => (window as any).game.test.play())).toBe(true);
    await expect(this.page.locator('#pause-overlay')).toBeHidden();
  }

  state(): Promise<GameStateView> {
    return this.page.evaluate(() => (window as any).game.test.state());
  }

  /** The HUD's store (src/game/hudStore.ts), as the React HUD renders it */
  hud(): Promise<any> {
    return this.page.evaluate(() => (window as any).game.hud.get());
  }

  /**
   * Start keeping every announcement, toast and kill-feed line the HUD shows (they only stay up for
   * a second or two, so polling the screen could miss them). Read them back with `messages()`.
   */
  async recordMessages(): Promise<void> {
    await this.page.evaluate(() => {
      const w = window as any;
      if (w.__messages) return;
      const log: string[] = (w.__messages = []);
      // Announcements and toasts are new objects each time they're shown; feed entries have ids.
      let announce: unknown = null;
      let toast: unknown = null;
      const feed = new Set<number>();
      const take = (s: any) => {
        if (s.announce && s.announce !== announce) log.push(`${s.announce.text} ${s.announce.sub}`.trim());
        if (s.toast && s.toast !== toast) log.push(s.toast.text);
        announce = s.announce;
        toast = s.toast;
        for (const f of [...(s.feed ?? [])].reverse()) {
          if (feed.has(f.id)) continue;
          feed.add(f.id);
          log.push(f.kind === 'info' ? f.text : `${f.killer?.name} > ${f.victim?.name}`);
        }
      };
      take(w.game.hud.get());
      w.game.hud.subscribe(() => take(w.game.hud.get()));
    });
  }

  messages(): Promise<string[]> {
    return this.page.evaluate(() => (window as any).__messages ?? []);
  }

  async id(): Promise<string> {
    return (await this.state()).id;
  }

  async teleport(x: number, y: number, z: number, yaw?: number): Promise<void> {
    await this.page.evaluate(([x, y, z, yaw]) => (window as any).game.test.teleport(x, y, z, yaw ?? undefined), [x, y, z, yaw ?? null] as const);
  }

  /** Face a point (yaw only matters for where we're going to walk or throw). */
  async face(x: number, y: number, z: number): Promise<void> {
    await this.page.evaluate(([x, y, z]) => (window as any).game.test.aimAtPoint(x, y, z), [x, y, z] as const);
  }

  async give(type: string): Promise<number> {
    return this.page.evaluate((t) => (window as any).game.test.give(t), type);
  }

  /**
   * Wait until `other` is in our game and drawn where they really stand (or at `at`, give or take
   * half a metre, when we know where they just went).
   */
  async waitForRemote(other: Player | string, at?: Vec3): Promise<void> {
    const id = typeof other === 'string' ? other : await other.id();
    await this.page.waitForFunction(({ id, at }) => {
      const t = (window as any).game?.test;
      if (!t || !t.remoteIds().includes(id) || !t.remoteSettled(id)) return false;
      if (!at) return true;
      const p = t.remotePos(id) as Vec3;
      return Math.hypot(p[0] - at[0], p[2] - at[2]) < 0.5;
    }, { id, at }, { timeout: 20_000 });
  }

  /**
   * Aim at `target` and pull the trigger until `shots` shots have gone off (each waits for the gun's
   * cooldown). Re-aims before every shot, since recoil moves the view. Returns the shots fired.
   */
  async shoot(target: Player | string, opts: { part?: 'body' | 'head'; shots?: number; timeout?: number } = {}): Promise<number> {
    const id = typeof target === 'string' ? target : await target.id();
    return this.page.evaluate(async ({ id, part, shots, timeout }) => {
      const t = (window as any).game.test;
      const end = performance.now() + timeout;
      let fired = 0;
      while (fired < shots && performance.now() < end) {
        if (t.aimAt(id, part) && t.fire()) fired++;
        await new Promise((r) => requestAnimationFrame(() => r(null)));
      }
      return fired;
    }, { id, part: opts.part ?? 'body', shots: opts.shots ?? 1, timeout: opts.timeout ?? 10_000 });
  }

  /** Fire at `target` until they're dead (or the time runs out). */
  async kill(target: Player, part: 'body' | 'head' = 'head'): Promise<void> {
    const end = Date.now() + 30_000;
    while (Date.now() < end) {
      if (!(await target.state()).alive) return;
      await this.shoot(target, { part, shots: 1 });
      await this.page.waitForTimeout(150);
    }
    throw new Error(`${this.name} couldn't kill ${target.name}`);
  }

  /** Hold a key for `ms` (the game reads held keys every frame). */
  async hold(code: string, ms: number): Promise<void> {
    await this.page.keyboard.down(code);
    await this.page.waitForTimeout(ms);
    await this.page.keyboard.up(code);
  }

  /**
   * Hold `keys` until `check` passes on our state (or the time runs out), then let go. Game time can run
   * slower than the wall clock on a software renderer, so tests wait on where we got to, not how long.
   */
  async holdUntil(keys: string[], check: (s: GameStateView) => boolean, timeout = 15_000): Promise<GameStateView> {
    for (const k of keys) await this.page.keyboard.down(k);
    try {
      await expect.poll(async () => check(await this.state()), { timeout, intervals: [50] }).toBe(true);
      return this.state();
    } finally {
      for (const k of [...keys].reverse()) await this.page.keyboard.up(k);
    }
  }

  async openPauseMenu(): Promise<void> {
    await this.page.evaluate(() => (window as any).game.pauseTouchPlay());
    await expect(this.page.locator('#pause-overlay')).toBeVisible();
  }

  async leave(): Promise<void> {
    if (!(await this.page.locator('#pause-overlay').isVisible())) await this.openPauseMenu();
    await this.page.getByRole('button', { name: 'Leave room' }).click();
    await expect(this.page.locator('#lobby')).toBeVisible();
  }

  async close(): Promise<void> {
    await this.context.close().catch(() => {});
  }
}

/** Spots on the classic map with a clear line between them (8 m apart across open floor, east of the centre block). */
export const DUEL = {
  a: [8, 0, 0] as Vec3,
  b: [16, 0, 0] as Vec3,
  /** Facing +x and -x */
  aYaw: -Math.PI / 2,
  bYaw: Math.PI / 2,
};
