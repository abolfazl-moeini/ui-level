import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { Browser } from "playwright-core";
import { launchBrowser } from "./resolver.js";

const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

export function getDaemonDirectory(): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : 1000;
  // Use fixed short /tmp path on POSIX to avoid macOS $TMPDIR 104-byte sun_path truncation
  const baseTmp = os.platform() === "win32" ? os.tmpdir() : "/tmp";
  return path.join(baseTmp, `ui-level-${uid}`);
}

export function getDaemonSocketPath(): string {
  return path.join(getDaemonDirectory(), "d.sock");
}

export async function isDaemonRunning(): Promise<boolean> {
  const socketPath = getDaemonSocketPath();
  if (!fs.existsSync(socketPath)) {
    return false;
  }

  return new Promise<boolean>((resolve) => {
    const req = http.request(
      {
        socketPath,
        path: "/health",
        method: "GET",
        timeout: 1000,
      },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      }
    );

    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });

    req.on("error", () => {
      try {
        if (fs.existsSync(socketPath)) {
          fs.unlinkSync(socketPath);
        }
      } catch {
        // Ignore
      }
      resolve(false);
    });

    req.end();
  });
}

export async function stopDaemon(): Promise<boolean> {
  const socketPath = getDaemonSocketPath();
  if (!fs.existsSync(socketPath)) {
    return false;
  }

  return new Promise<boolean>((resolve) => {
    const req = http.request(
      {
        socketPath,
        path: "/shutdown",
        method: "POST",
        timeout: 2000,
      },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      }
    );

    req.on("error", () => {
      try {
        if (fs.existsSync(socketPath)) {
          fs.unlinkSync(socketPath);
        }
      } catch {
        // Ignore
      }
      resolve(false);
    });

    req.end();
  });
}

export async function sendDaemonRequest<T = any>(payload: any): Promise<T> {
  const socketPath = getDaemonSocketPath();
  const body = JSON.stringify(payload);

  return new Promise<T>((resolve, reject) => {
    const req = http.request(
      {
        socketPath,
        path: "/check",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          try {
            const raw = Buffer.concat(chunks).toString("utf-8");
            const data = JSON.parse(raw);
            if (res.statusCode && res.statusCode >= 400) {
              reject(new Error(data.error || `Daemon error HTTP ${res.statusCode}`));
            } else {
              resolve(data);
            }
          } catch (err) {
            reject(err);
          }
        });
      }
    );

    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

export async function startDaemon(
  handler: (payload: any, browser: Browser) => Promise<any>,
  idleTimeoutMs: number = DEFAULT_IDLE_TIMEOUT_MS
): Promise<void> {
  const daemonDir = getDaemonDirectory();
  const socketPath = getDaemonSocketPath();

  if (await isDaemonRunning()) {
    return;
  }

  fs.mkdirSync(daemonDir, { recursive: true, mode: 0o700 });
  if (fs.existsSync(socketPath)) {
    try {
      fs.unlinkSync(socketPath);
    } catch {
      // Ignore
    }
  }

  const browser = await launchBrowser();
  let idleTimer: NodeJS.Timeout | null = null;
  let server: http.Server;

  const cleanup = async () => {
    if (idleTimer) clearTimeout(idleTimer);
    try {
      server?.close();
    } catch {
      // Ignore
    }
    try {
      await browser.close();
    } catch {
      // Ignore
    }
    try {
      if (fs.existsSync(socketPath)) {
        fs.unlinkSync(socketPath);
      }
    } catch {
      // Ignore
    }
    process.exit(0);
  };

  function resetIdleTimer() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      void cleanup();
    }, idleTimeoutMs);
  }

  server = http.createServer(async (req, res) => {
    resetIdleTimer();

    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", pid: process.pid }));
      return;
    }

    if (req.method === "POST" && req.url === "/shutdown") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "stopping" }));
      setImmediate(() => void cleanup());
      return;
    }

    if (req.method === "POST" && req.url === "/check") {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", async () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
          const result = await handler(body, browser);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result));
        } catch (err: any) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err?.message || "Internal error" }));
        }
      });
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(socketPath, () => {
      try {
        fs.chmodSync(socketPath, 0o600);
      } catch {
        // Ignore
      }
      resolve();
    });
    server.on("error", reject);
  });

  resetIdleTimer();

  process.on("SIGINT", () => void cleanup());
  process.on("SIGTERM", () => void cleanup());
}
