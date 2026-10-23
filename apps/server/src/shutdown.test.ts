import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { connect } from "node:net";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { configureLog } from "./log.js";
import { SHUTDOWN_TIMEOUT_MS, installShutdown } from "./shutdown.js";

configureLog("error", { silent: true });

function setup(run: () => Promise<void>, timeoutMs = 10_000) {
  const proc = new EventEmitter();
  const exit = vi.fn<(code: number) => void>();
  const runSpy = vi.fn(run);
  installShutdown({ run: runSpy, proc: proc as unknown as NodeJS.Process, exit, timeoutMs });
  return { proc, exit, run: runSpy };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("process shutdown", () => {
  it.each(["SIGINT", "SIGTERM", "SIGBREAK"])("%s shuts down gracefully, then exits 0", async (signal) => {
    const { proc, exit, run } = setup(async () => undefined);
    proc.emit(signal);
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(run).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it("exits anyway when the graceful shutdown hangs", async () => {
    const { proc, exit } = setup(() => new Promise(() => undefined), 30);
    proc.emit("SIGINT");
    await tick();
    expect(exit).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1), { timeout: 1000 });
  });

  it("exits 1 when the shutdown fails", async () => {
    const { proc, exit } = setup(async () => {
      throw new Error("store close failed");
    });
    proc.emit("SIGTERM");
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
  });

  it("a second stop request during shutdown exits at once", async () => {
    let release!: () => void;
    const { proc, exit, run } = setup(() => new Promise<void>((r) => (release = r)));
    proc.emit("SIGINT");
    await tick();
    proc.emit("SIGINT");
    expect(exit).toHaveBeenCalledWith(1);
    release();
    await tick();
    expect(run).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it("an uncaught exception shuts down and exits 1", async () => {
    const { proc, exit } = setup(async () => undefined);
    proc.emit("uncaughtException", new Error("boom"));
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
  });
});

describe("the game service process", () => {
  const root = fileURLToPath(new URL("../../..", import.meta.url));

  it.each(["SIGINT", "SIGTERM"] as const)("exits by itself after %s, even with a proxy's keep-alive connection open", async (signal) => {
    const port = String(26000 + Math.floor(Math.random() * 2000));
    const child = spawn(process.execPath, ["--conditions=source", "--import", "tsx", "apps/server/src/index.ts"], {
      cwd: root,
      env: { ...process.env, NODE_ENV: "development", PORT: port, HOST: "127.0.0.1", ALLOWED_ORIGINS: "http://localhost:5173", DATABASE_URL: "", LOG_LEVEL: "info" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (b) => (out += String(b)));
    child.stderr.on("data", (b) => (out += String(b)));
    const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
    let sock: ReturnType<typeof connect> | null = null;
    try {
      await vi.waitFor(() => expect(out).toContain("game service listening"), { timeout: 30_000, interval: 100 });
      // Like Caddy or IIS: one request, then the connection stays open and idle in the pool.
      sock = connect(Number(port), "127.0.0.1");
      let reply = "";
      sock.on("data", (b) => (reply += String(b)));
      sock.on("error", () => undefined);
      sock.write("GET /healthz HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: keep-alive\r\n\r\n");
      await vi.waitFor(() => expect(reply).toContain("200 OK"), { timeout: 5000 });
      const t0 = Date.now();
      child.kill(signal);
      const code = await Promise.race([exited, new Promise<"hung">((r) => setTimeout(() => r("hung"), 12_000))]);
      expect(code).toBe(0);
      expect(Date.now() - t0).toBeLessThan(SHUTDOWN_TIMEOUT_MS);
      expect(out).toContain("shutdown complete");
    } finally {
      sock?.destroy();
      child.kill("SIGKILL");
    }
  }, 60_000);
});
