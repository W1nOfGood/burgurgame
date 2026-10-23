import { log } from "./log.js";

/**
 * Process shutdown for the game service.
 *
 * SIGINT (Ctrl+C, which NSSM sends to stop a Windows service), SIGTERM (Docker, systemd) and
 * SIGBREAK (Ctrl+Break on Windows) run the graceful shutdown once — rooms checkpoint and close,
 * connections and the store close — and then the process exits explicitly. It never relies on
 * the event loop draining by itself: on Windows a service whose process lingers after shutdown
 * stays "Stop pending" and cannot be stopped or restarted. A safety timer exits anyway if the
 * shutdown hangs, and a second signal during shutdown exits at once.
 */

export const SHUTDOWN_SIGNALS: readonly NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGBREAK"];
/** Below NSSM's console-stop wait (AppStopMethodConsole 10000), so the service always ends on its own. */
export const SHUTDOWN_TIMEOUT_MS = 8_000;

export interface ShutdownOptions {
  /** The graceful shutdown (resolves once everything is closed). */
  run: () => Promise<void>;
  timeoutMs?: number;
  /** Injected for tests; defaults to the real process. */
  proc?: Pick<NodeJS.Process, "on">;
  exit?: (code: number) => void;
  signals?: readonly NodeJS.Signals[];
}

export function installShutdown(opts: ShutdownOptions): (reason: string, code?: number) => Promise<void> {
  const proc = opts.proc ?? process;
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  const timeoutMs = opts.timeoutMs ?? SHUTDOWN_TIMEOUT_MS;
  let stopping = false;
  let exited = false;
  const finish = (code: number) => {
    if (exited) return;
    exited = true;
    exit(code);
  };

  const shutdown = async (reason: string, code = 0): Promise<void> => {
    if (stopping) {
      log.warn("second stop request during shutdown; exiting now", { reason });
      finish(1);
      return;
    }
    stopping = true;
    log.info("shutting down", { reason });
    const timer = setTimeout(() => {
      log.error("shutdown did not finish in time; exiting anyway", { timeoutMs });
      finish(1);
    }, timeoutMs);
    // The timer must not be what keeps a finished process alive.
    timer.unref?.();
    try {
      await opts.run();
    } catch (err) {
      log.error("error during shutdown", { err: err as Error });
      code = 1;
    }
    clearTimeout(timer);
    await flushStdio();
    finish(code);
  };

  for (const signal of opts.signals ?? SHUTDOWN_SIGNALS) {
    proc.on(signal, () => void shutdown(signal));
  }
  proc.on("uncaughtException", (err: Error) => {
    log.error("uncaught exception", { err });
    void shutdown("uncaughtException", 1);
  });
  return shutdown;
}

/** Waits (briefly) for buffered log lines to reach stdout/stderr before the process exits. */
function flushStdio(maxMs = 1000): Promise<void> {
  return new Promise((resolve) => {
    let pending = 2;
    const done = () => {
      pending -= 1;
      if (pending === 0) resolve();
    };
    const cap = setTimeout(resolve, maxMs);
    cap.unref?.();
    process.stdout.write("", done);
    process.stderr.write("", done);
  });
}
