import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".eot": "application/vnd.ms-fontobject",
};

export interface StaticServerInstance {
  port: number;
  baseUrl: string;
  rootDir: string;
  close: () => Promise<void>;
  getUrlForFile: (filePath: string) => string;
}

export function findProjectRoot(targetPath: string, explicitRoot?: string): string {
  const absTarget = path.resolve(targetPath);

  if (explicitRoot) {
    const resolvedExplicit = path.resolve(explicitRoot);
    if (absTarget.startsWith(resolvedExplicit)) {
      return resolvedExplicit;
    }
  }
  let currentDir = fs.existsSync(absTarget) && fs.statSync(absTarget).isDirectory()
    ? absTarget
    : path.dirname(absTarget);

  const rootMarkers = [".git", "package.json", "node_modules", "assets", "css"];

  while (currentDir !== path.dirname(currentDir)) {
    for (const marker of rootMarkers) {
      if (fs.existsSync(path.join(currentDir, marker))) {
        return currentDir;
      }
    }
    currentDir = path.dirname(currentDir);
  }

  return fs.existsSync(absTarget) && fs.statSync(absTarget).isDirectory()
    ? absTarget
    : path.dirname(absTarget);
}

export async function startStaticServer(rootDir: string): Promise<StaticServerInstance> {
  const resolvedRoot = path.resolve(rootDir);

  const server = http.createServer((req, res) => {
    try {
      const rawUrl = req.url || "/";
      const parsedPath = decodeURIComponent(new URL(rawUrl, "http://127.0.0.1").pathname);
      const safeRelativePath = path.normalize(parsedPath).replace(/^(\.\.[/\\])+/, "");
      const fullPath = path.join(resolvedRoot, safeRelativePath);

      // Path traversal security check
      if (!fullPath.startsWith(resolvedRoot)) {
        res.writeHead(403, { "Content-Type": "text/plain" });
        res.end("403 Forbidden");
        return;
      }

      let filePathToServe = fullPath;
      if (fs.existsSync(fullPath) && fs.statSync(fullPath).isDirectory()) {
        const indexHtml = path.join(fullPath, "index.html");
        if (fs.existsSync(indexHtml)) {
          filePathToServe = indexHtml;
        }
      }

      if (!fs.existsSync(filePathToServe) || fs.statSync(filePathToServe).isDirectory()) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end(`404 Not Found: ${parsedPath}`);
        return;
      }

      const ext = path.extname(filePathToServe).toLowerCase();
      const contentType = MIME_TYPES[ext] || "application/octet-stream";

      const stream = fs.createReadStream(filePathToServe);
      res.writeHead(200, {
        "Content-Type": contentType,
        "Cache-Control": "no-cache, no-store, must-revalidate",
        "Access-Control-Allow-Origin": "*",
      });
      stream.pipe(res);
    } catch (err: any) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end(`500 Server Error: ${err?.message || "unknown"}`);
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => resolve());
    server.on("error", reject);
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to obtain server address");
  }

  const port = address.port;
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    port,
    baseUrl,
    rootDir: resolvedRoot,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
    getUrlForFile: (filePath: string) => {
      const abs = path.resolve(filePath);
      const rel = path.relative(resolvedRoot, abs);
      const normalizedRel = rel.split(path.sep).join("/");
      return `${baseUrl}/${normalizedRel}`;
    },
  };
}
