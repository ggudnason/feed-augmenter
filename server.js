// Feed Augmenter — fetches remote JSON feeds, applies custom rules, and serves
// the result on the LAN for vMix. No dependencies: requires Node.js 18+.
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { URL } = require("url");

const CONFIG_PATH = process.env.CONFIG_PATH || path.join(__dirname, "config.json");
const PUBLIC_DIR = path.join(__dirname, "public");
const HOST = process.env.HOST || "0.0.0.0";
const FETCH_TIMEOUT_MS = 10000;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG = {
  port: 47820,
  feeds: [
    {
      id: "default",
      name: "Example feed",
      slug: "stream1",
      url: "https://example.com/vmix/your-feed.json",
      output: "nested",
      nestKey: "custom",
      cacheSeconds: 1,
      rules: [
        { type: "static", field: "provider", value: "GST" },
        { type: "template", field: "next_session_text", template: "{next_time} GST · {track}", tidy: true },
        { type: "template", field: "next_session_title", template: "{next_title}", tidy: true },
      ],
    },
  ],
};

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.error(`Could not read ${CONFIG_PATH}: ${error.message}`);
      console.error("Fix or delete the file and restart.");
      process.exit(1);
    }
    saveConfig(DEFAULT_CONFIG);
    return structuredClone(DEFAULT_CONFIG);
  }
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n", "utf8");
}

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function validateConfig(input) {
  if (!input || !Array.isArray(input.feeds)) throw new Error("Config must contain a feeds array");
  const seen = new Set();
  const feeds = input.feeds.map((feed, index) => {
    const slug = slugify(feed.slug || feed.name);
    if (!slug) throw new Error(`Feed #${index + 1} needs a slug`);
    if (seen.has(slug)) throw new Error(`Duplicate slug "${slug}"`);
    seen.add(slug);
    if (!/^https?:\/\//i.test(String(feed.url || ""))) {
      throw new Error(`Feed "${slug}" needs an http(s) URL`);
    }
    return {
      id: feed.id || `${Date.now().toString(36)}${index}`,
      name: String(feed.name || slug),
      slug,
      url: String(feed.url).trim(),
      output: feed.output === "flat" ? "flat" : "nested",
      nestKey: String(feed.nestKey || "custom").trim() || "custom",
      cacheSeconds: Math.max(0, Number(feed.cacheSeconds) || 0),
      rules: Array.isArray(feed.rules) ? feed.rules : [],
    };
  });
  return { port: Number(input.port) || config.port || DEFAULT_CONFIG.port, feeds };
}

let config = loadConfig();
const PORT = Number(process.env.PORT || config.port || DEFAULT_CONFIG.port);

// ---------------------------------------------------------------------------
// Rule engine
// ---------------------------------------------------------------------------

function normalizePayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === "object") return [payload];
  if (payload == null) return [];
  return [{ value: payload }];
}

function lookup(ctx, key) {
  if (key in ctx) return ctx[key];
  return key.split(".").reduce((obj, part) => (obj == null ? undefined : obj[part]), ctx);
}

function toText(value) {
  if (value == null) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

// Removes dangling separators left behind when a placeholder is empty,
// e.g. "GST ·  · " -> "GST".
const SEP = "[·•|,/–—-]";
const LEADING_SEP = new RegExp(`^(?:${SEP}\\s*)+`);
const TRAILING_SEP = new RegExp(`(?:\\s*${SEP})+$`);
const DOUBLE_SEP = new RegExp(`\\s(${SEP})(?:\\s+${SEP})+\\s`, "g");

function tidy(text) {
  return text
    .replace(/\s+/g, " ")
    .trim()
    .replace(DOUBLE_SEP, " $1 ")
    .replace(LEADING_SEP, "")
    .replace(TRAILING_SEP, "")
    .trim();
}

// "{field}" inserts a value; "{field|fallback}" uses fallback when empty.
function render(template, ctx, shouldTidy) {
  const out = String(template ?? "").replace(/\{([^{}|]+)(?:\|([^{}]*))?\}/g, (_, key, fallback) => {
    const value = toText(lookup(ctx, key.trim()));
    return value.trim() === "" && fallback !== undefined ? fallback : value;
  });
  return shouldTidy ? tidy(out) : out;
}

function matches(cond, ctx) {
  const actual = toText(lookup(ctx, String(cond.field || "").trim())).trim().toLowerCase();
  const expected = render(cond.value, ctx, false).trim().toLowerCase();
  switch (cond.op) {
    case "not_equals": return actual !== expected;
    case "contains": return actual.includes(expected);
    case "not_contains": return !actual.includes(expected);
    case "empty": return actual === "";
    case "not_empty": return actual !== "";
    case "equals":
    default: return actual === expected;
  }
}

function applyRules(row, feed) {
  if (!row || typeof row !== "object" || Array.isArray(row)) return row;

  const source = { ...row };
  const added = {};
  const ctx = () => ({ ...source, ...added });

  for (const rule of feed.rules || []) {
    if (!rule || rule.enabled === false) continue;
    const field = String(rule.field || "").trim();

    switch (rule.type) {
      case "static":
        if (field) added[field] = rule.value ?? "";
        break;
      case "template":
        if (field) added[field] = render(rule.template, ctx(), rule.tidy);
        break;
      case "conditional": {
        if (!field) break;
        const c = ctx();
        const hit = (rule.cases || []).find((item) => matches(item, c));
        added[field] = render(hit ? hit.then : rule.otherwise, c, rule.tidy);
        break;
      }
      case "override":
        if (field) source[field] = render(rule.value, ctx(), rule.tidy);
        break;
      case "rename": {
        const from = String(rule.from || "").trim();
        const to = String(rule.to || "").trim();
        if (from && to && from in source) {
          source[to] = source[from];
          delete source[from];
        }
        break;
      }
      case "remove":
        if (field) delete source[field];
        break;
    }
  }

  return feed.output === "flat" ? { ...source, ...added } : { ...source, [feed.nestKey || "custom"]: added };
}

function augment(payload, feed) {
  return normalizePayload(payload).map((row) => applyRules(row, feed));
}

// ---------------------------------------------------------------------------
// Fetching with short cache, in-flight dedupe and last-good fallback
// ---------------------------------------------------------------------------

const cache = new Map(); // url -> { data, fetchedAt, inflight }
const status = new Map(); // slug -> { lastRequest, lastOk, lastError, requests, stale }

async function fetchRemote(url, cacheSeconds) {
  const entry = cache.get(url) || {};
  cache.set(url, entry);

  if (entry.data !== undefined && Date.now() - entry.fetchedAt < cacheSeconds * 1000) {
    return { data: entry.data, stale: false };
  }

  if (!entry.inflight) {
    entry.inflight = (async () => {
      try {
        const response = await fetch(url, {
          headers: { "User-Agent": "FeedAugmenter/1.0", Accept: "application/json" },
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        if (!response.ok) throw new Error(`Remote returned HTTP ${response.status}`);
        const text = await response.text();
        try {
          entry.data = JSON.parse(text);
        } catch {
          throw new Error("Remote did not return valid JSON");
        }
        entry.fetchedAt = Date.now();
        entry.error = null;
      } catch (error) {
        entry.error = error.name === "TimeoutError" ? "Remote timed out" : String(error.message || error);
      } finally {
        entry.inflight = null;
      }
    })();
  }
  await entry.inflight;

  if (entry.error) {
    // Keep graphics on air: serve the last good payload if we have one.
    if (entry.data !== undefined) return { data: entry.data, stale: true, error: entry.error };
    throw new Error(entry.error);
  }
  return { data: entry.data, stale: false };
}

function recordStatus(slug, result, error) {
  const s = status.get(slug) || { requests: 0 };
  s.requests += 1;
  s.lastRequest = new Date().toISOString();
  if (error) {
    s.lastError = error;
    s.lastErrorAt = s.lastRequest;
  } else {
    s.lastOk = s.lastRequest;
    s.stale = Boolean(result.stale);
    if (result.error) {
      s.lastError = result.error;
      s.lastErrorAt = s.lastRequest;
    }
  }
  status.set(slug, s);
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function sendJson(res, code, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store, no-cache, must-revalidate",
    "Content-Length": Buffer.byteLength(body, "utf8"),
    ...CORS,
    ...extraHeaders,
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 1024 * 1024) {
        reject(new Error("Request body too large"));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };

function serveStatic(res, pathname) {
  const file = path.normalize(path.join(PUBLIC_DIR, pathname === "/" ? "index.html" : pathname));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return false;
  let body;
  try {
    body = fs.readFileSync(file);
  } catch {
    return false;
  }
  res.writeHead(200, {
    "Content-Type": `${MIME[path.extname(file)] || "application/octet-stream"}; charset=utf-8`,
    "Cache-Control": "no-cache",
  });
  res.end(body);
  return true;
}

function lanAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((net) => net && net.family === "IPv4" && !net.internal && !net.address.startsWith("169.254."))
    .map((net) => net.address);
}

async function handleFeed(res, slug, raw) {
  const feed = config.feeds.find((f) => f.slug === slug);
  if (!feed) {
    sendJson(res, 404, { error: `No feed "${slug}"`, available: config.feeds.map((f) => `/feed/${f.slug}`) });
    return;
  }
  try {
    const result = await fetchRemote(feed.url, feed.cacheSeconds);
    recordStatus(slug, result);
    const body = raw ? normalizePayload(result.data) : augment(result.data, feed);
    sendJson(res, 200, body, result.stale ? { "X-Feed-Stale": "1" } : {});
  } catch (error) {
    recordStatus(slug, null, error.message);
    sendJson(res, 502, { error: "Failed to fetch remote feed", details: error.message });
  }
}

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, "http://localhost");

  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS);
    res.end();
    return;
  }

  try {
    const feedMatch = pathname.match(/^\/feed\/([^/]+)(\/raw)?\/?$/);
    if (feedMatch && req.method === "GET") {
      await handleFeed(res, decodeURIComponent(feedMatch[1]), Boolean(feedMatch[2]));
      return;
    }

    if (pathname === "/api/config" && req.method === "GET") {
      sendJson(res, 200, config);
      return;
    }

    if (pathname === "/api/config" && req.method === "PUT") {
      const next = validateConfig(await readBody(req));
      saveConfig(next);
      config = next;
      sendJson(res, 200, config);
      return;
    }

    if (pathname === "/api/status" && req.method === "GET") {
      sendJson(res, 200, {
        port: PORT,
        addresses: ["localhost", ...lanAddresses()],
        feeds: Object.fromEntries(status),
      });
      return;
    }

    // Preview an unsaved feed definition from the dashboard editor.
    if (pathname === "/api/preview" && req.method === "POST") {
      const feed = await readBody(req);
      if (!/^https?:\/\//i.test(String(feed.url || ""))) {
        sendJson(res, 400, { error: "Enter an http(s) URL" });
        return;
      }
      try {
        const result = await fetchRemote(String(feed.url).trim(), feed.fresh ? 0 : 5);
        sendJson(res, 200, {
          raw: normalizePayload(result.data),
          output: augment(result.data, feed),
          stale: result.stale,
          error: result.error,
        });
      } catch (error) {
        sendJson(res, 502, { error: error.message });
      }
      return;
    }

    if (pathname === "/health") {
      sendJson(res, 200, { status: "ok", feeds: config.feeds.length });
      return;
    }

    if (req.method === "GET" && serveStatic(res, pathname)) return;

    sendJson(res, 404, { error: "Not found" });
  } catch (error) {
    sendJson(res, 400, { error: error.message });
  }
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`Port ${PORT} is already in use. Set "port" in config.json or run with PORT=xxxx.`);
  } else {
    console.error(error);
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(`Feed Augmenter running`);
  console.log(`  Dashboard:  http://localhost:${PORT}/`);
  for (const ip of lanAddresses()) console.log(`  LAN:        http://${ip}:${PORT}/`);
  console.log(`  Config:     ${CONFIG_PATH}`);
  for (const feed of config.feeds) console.log(`  Feed:       http://localhost:${PORT}/feed/${feed.slug}`);

  if (process.argv.includes("--open")) openBrowser(`http://localhost:${PORT}/`);
});

function openBrowser(url) {
  const { spawn } = require("child_process");
  const [cmd, args] =
    process.platform === "win32" ? ["cmd", ["/c", "start", "", url]]
    : process.platform === "darwin" ? ["open", [url]]
    : ["xdg-open", [url]];
  spawn(cmd, args, { stdio: "ignore", detached: true }).on("error", () => {}).unref();
}
