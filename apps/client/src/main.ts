import { initPhysics, type Rapier } from "@ahb/simulation";
import { PROTOCOL_VERSION } from "@ahb/protocol";
import { AudioEngine } from "./game/audio.js";
import { Game, createEngine } from "./game/game.js";
import { ApiError, ensureGuest, exportRestaurant, recoverGuest, storedGuest } from "./net/api.js";
import { Session, type JoinRequest } from "./net/session.js";
import { isTouchDevice, loadSettings, saveSettings, storageGet, type Settings } from "./settings.js";
import { Ui } from "./ui/ui.js";

const canvas = document.getElementById("game") as HTMLCanvasElement;
const ui = new Ui(document.getElementById("ui")!);
let settings: Settings = loadSettings();
const audio = new AudioEngine(settings);
let rapier: Promise<Rapier> | null = null;
let game: Game | null = null;
let session: Session | null = null;
let busy = false;

const debug = new URLSearchParams(location.search).has("debug");

function physics(): Promise<Rapier> {
  rapier ??= initPhysics();
  return rapier;
}

function platform(): "desktop" | "touch" {
  return isTouchDevice() ? "touch" : "desktop";
}

function friendly(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/not found|invalid_room|MATCHMAKE_INVALID_ROOM_ID/i.test(msg)) return "No kitchen with that code is open. Check the code with your friend.";
  if (/locked|full/i.test(msg)) return "That kitchen is full (four cooks max).";
  if (/version/i.test(msg)) return "Your game is out of date. Reload the page to update.";
  if (/already in this kitchen/i.test(msg)) return "You're already in this kitchen in another tab.";
  if (/Failed to fetch|NetworkError|ECONNREFUSED|reach the game server/i.test(msg)) return "Can't reach the game server. Check your connection and try again.";
  return msg || "Something went wrong.";
}

function title(notice?: string): void {
  ui.setHudVisible(false);
  ui.showTitle(storedGuest()?.name ?? storageGet("ahb.guest.name") ?? "", {
    create: (name, mode) => void start(name, { mode }),
    join: (name, code) => void start(name, { code }),
    settings: () => openSettings(() => title()),
    recover: (code, name) =>
      void recoverGuest(code, name)
        .then(() => title("Guest profile restored."))
        .catch((e: unknown) => title(e instanceof ApiError ? e.message : "That recovery code didn't work.")),
  }, notice);
}

async function start(name: string, opts: { code?: string; mode?: "relaxed" | "normal" }): Promise<void> {
  if (busy) return;
  busy = true;
  void audio.unlock();
  ui.showLoading(opts.code ? `Joining ${opts.code}…` : "Opening your kitchen…");
  try {
    const guest = await ensureGuest(name);
    const req: JoinRequest = { name, platform: platform(), ...(opts.mode ? { mode: opts.mode } : {}) };
    const [R, s] = await Promise.all([physics(), opts.code ? Session.join(guest.token, opts.code, req) : Session.create(guest.token, req)]);
    await enter(s, R);
  } catch (err) {
    console.error(err);
    ui.showError("Couldn't open the kitchen", friendly(err), [
      { label: "Try again", primary: true, run: () => void ((busy = false), start(name, opts)) },
      { label: "Back", run: () => title() },
    ]);
  } finally {
    busy = false;
  }
}

async function waitForState(s: Session): Promise<void> {
  const deadline = Date.now() + 8000;
  while (!s.state?.players?.has(s.sessionId)) {
    if (Date.now() > deadline) throw new Error("The kitchen didn't respond in time.");
    await new Promise((r) => setTimeout(r, 30));
  }
}

async function enter(s: Session, R: Rapier): Promise<void> {
  session = s;
  ui.showLoading("Setting up the kitchen…");
  await waitForState(s);
  const engine = await createEngine(canvas, settings);
  game = new Game(engine, canvas, s, ui, settings, R, audio, {
    openMenu: openMenu,
    openPing: openPing,
    openRecipes: () => openRecipes(false),
    leave: (reason, code) => onLeft(reason, code),
  });
  if (debug) {
    const g = game;
    (window as unknown as Record<string, unknown>).__ahb = {
      game: g,
      session: s,
      version: PROTOCOL_VERSION,
      /** Works only against a server started with ENABLE_TEST_HOOKS=1. */
      teleport: (x: number, z: number, yaw: number, pitch: number) => {
        s.room.send("debugTeleport", { x, z, yaw, pitch });
        g.debugLook(yaw, pitch);
      },
    };
  }
  ui.hideScreen();
  if (platform() === "touch" && !settings.touchTutorialSeen) {
    game.setMenuOpen(true);
    ui.showTouchTutorial(() => {
      settings.touchTutorialSeen = true;
      saveSettings(settings);
      ui.hideScreen();
      game?.setMenuOpen(false);
    });
  } else if (platform() === "desktop") {
    ui.toast("Click to look around. WASD to move, click to pick up, Esc for menu.", "info", 5000);
  }
}

function onLeft(reason: string, code: number): void {
  const g = game;
  game = null;
  g?.dispose();
  const s = session;
  session = null;
  if (code === 1000 || code === 4000) {
    title();
    return;
  }
  const restarting = code === 4100;
  ui.showError(
    restarting ? "Server restarting" : "Disconnected",
    restarting
      ? "The server is restarting for maintenance. Your restaurant was saved — reopen it in a moment (others can rejoin with the new code)."
      : reason || "The connection to the kitchen was lost and couldn't be restored.",
    [
      {
        label: "Rejoin",
        primary: true,
        run: () => {
          const guest = storedGuest();
          if (!guest || !s) return title();
          void Session.resume(guest.token).then(async (resumed) => {
            if (resumed) await enter(resumed, await physics());
            else title("That kitchen session has ended. Open your kitchen again or join with a new code.");
          });
        },
      },
      { label: "Main menu", run: () => title() },
    ],
  );
}

function openMenu(): void {
  const g = game;
  const s = session;
  if (!g || !s) return;
  g.setMenuOpen(true);
  const st = s.state;
  const connected = [...st.players.values()].filter((p) => p.connected).length;
  const close = () => {
    ui.hideScreen();
    g.setMenuOpen(false);
    if (platform() === "desktop") g.input.requestLock();
  };
  ui.showPauseMenu(
    { code: s.welcome?.code ?? s.room.roomId, solo: connected <= 1, paused: st.paused, isOwner: s.welcome?.isOwner ?? false, votes: `(${st.pauseVotes.length}/${connected})` },
    {
      resume: close,
      pause: () => {
        void s.command("pause", { action: st.paused ? "resume" : "request" }).then((r) => {
          if (!r.ok && r.reason) ui.toast(r.reason, "warn");
        });
        close();
      },
      leave: () => {
        game = null;
        g.dispose();
        void s.leave().then(() => title());
      },
      exportSave: () => {
        const guest = storedGuest();
        if (!guest || !s.welcome) return;
        void exportRestaurant(guest.token, s.welcome.restaurantId)
          .then((blob) => {
            const a = document.createElement("a");
            a.href = URL.createObjectURL(blob);
            a.download = `after-hours-${s.welcome!.restaurantId}.json`;
            a.click();
            setTimeout(() => URL.revokeObjectURL(a.href), 2000);
          })
          .catch((e: unknown) => ui.toast(e instanceof Error ? e.message : "Export failed", "warn"));
      },
      settings: () => openSettings(openMenu),
      copyCode: () => {
        void navigator.clipboard?.writeText(s.welcome?.code ?? s.room.roomId).then(
          () => ui.toast("Room code copied", "success"),
          () => ui.toast(`Room code: ${s.welcome?.code ?? s.room.roomId}`, "info"),
        );
      },
      ping: openPing,
      recipes: () => openRecipes(true),
    },
  );
}

function openRecipes(fromMenu: boolean): void {
  const g = game;
  if (!g) return;
  g.setMenuOpen(true);
  ui.showRecipeBook(() => {
    if (fromMenu) return openMenu();
    ui.hideScreen();
    g.setMenuOpen(false);
    if (platform() === "desktop") g.input.requestLock();
  });
}

function openPing(): void {
  const g = game;
  if (!g) return;
  g.setMenuOpen(true);
  const close = () => {
    ui.hideScreen();
    g.setMenuOpen(false);
    if (platform() === "desktop") g.input.requestLock();
  };
  ui.showPingMenu(
    (preset) => {
      g.sendPing(preset);
      close();
    },
    close,
  );
}

function openSettings(back: () => void): void {
  ui.showSettings(
    settings,
    (next) => {
      settings = next;
      saveSettings(settings);
      audio.applySettings(settings);
      game?.applySettings(settings);
    },
    back,
    { recoveryCode: storedGuest()?.token },
  );
}

async function boot(): Promise<void> {
  // A reload within the reconnect grace period resumes the same kitchen seat.
  const guest = storedGuest();
  if (guest && storageGet("ahb.reconnect")) {
    ui.showLoading("Rejoining your kitchen…");
    try {
      const [R, resumed] = await Promise.all([physics(), Session.resume(guest.token)]);
      if (resumed) {
        await enter(resumed, R);
        return;
      }
    } catch (err) {
      console.warn("resume failed", err);
    }
  }
  title();
  void physics();
}

window.addEventListener("error", (e) => {
  if (!game) return;
  console.error(e.error ?? e.message);
});

void boot();
