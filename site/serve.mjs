/**
 * Local dev server for the site.
 *
 *   node site/serve.mjs            -> http://localhost:8788
 *   node site/serve.mjs 3000       -> custom port
 *
 * WHY THIS EXISTS RATHER THAN `npx serve`
 *
 * 1. Deep links. /stop/1234 and /route/80 have no file behind them; Cloudflare
 *    Pages rewrites them to index.html via _redirects. A plain static server
 *    returns 404, so bookmarked URLs would appear broken locally while
 *    working in production -- the worst kind of difference to debug. This
 *    mirrors the _redirects rules.
 *
 * 2. A real origin. The client fetches absolute paths (/data/index.json) and
 *    calls navigator.geolocation. Opening index.html from the filesystem gives
 *    an opaque `file://` origin where absolute paths resolve to the drive root
 *    and geolocation is blocked outright. A double-click genuinely cannot work.
 *
 * No dependencies: Node's own http and fs, so there is nothing to install.
 */
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "public");
const PORT = Number(process.argv[2] ?? 8788);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};

const server = createServer(async (req, res) => {
  let urlPath = decodeURIComponent((req.url ?? "/").split("?")[0]);

  // Mirror _redirects: /stop/* rewrites to the shell with a 200, so the
  // address bar keeps the real URL. Data and assets are matched first so the
  // catch-all cannot swallow them.
  if (urlPath === "/") urlPath = "/index.html";
  else if (urlPath.startsWith("/stop/") || urlPath.startsWith("/route/") || urlPath === "/about" || urlPath === "/about/") urlPath = "/index.html";

  // Contain path traversal: normalise, then verify the result is still inside
  // ROOT before touching the filesystem.
  const filePath = join(ROOT, normalize(urlPath));
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403).end("Forbidden");
    return;
  }

  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error("not a file");
    const body = await readFile(filePath);
    res.writeHead(200, {
      "Content-Type": TYPES[extname(filePath)] ?? "application/octet-stream",
      // No caching in dev: a re-export should be visible on refresh, not
      // masked by a stale copy.
      "Cache-Control": "no-store",
    });
    res.end(body);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" }).end(`404: ${urlPath}`);
  }
});

server.listen(PORT, () => {
  console.log(`\n  Madison Metro site → http://localhost:${PORT}\n`);
  console.log(`  serving ${ROOT}`);
  console.log(`  deep links (/stop/1234) rewritten to the shell, as Pages does`);
  console.log(`  Ctrl+C to stop\n`);
});
