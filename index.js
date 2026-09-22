// MZForge API on Cloudflare Workers + D1.
//
// Port of the original Go API. Same endpoints and behaviour, except:
//  - storage is D1 (SQLite) instead of servers.json;
//  - the ZIP is assembled in the browser (the launcher exe is a static
//    asset next to index.html), so /allocate returns the config files'
//    contents instead of a one-time /download/{token} link.
// The launcher itself is unchanged: /announce and /probe take the same
// requests with the same bearer-token auth.

import { mcPing } from "./mcping.js";

// ---------------------------------------------------------------- schema

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS servers (
    server_id TEXT PRIMARY KEY,
    server_token TEXT NOT NULL,
    manage_key_hash TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    hostname TEXT NOT NULL,
    custom_hostname TEXT NOT NULL,
    connect_endpoint TEXT NOT NULL,
    cf_record_id TEXT NOT NULL DEFAULT '',
    loader TEXT NOT NULL,
    mc_version TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'unknown',
    verified_version TEXT NOT NULL DEFAULT '',
    last_seen TEXT NOT NULL DEFAULT '',
    live_status TEXT NOT NULL DEFAULT '',
    live_version TEXT NOT NULL DEFAULT '',
    checked_at INTEGER NOT NULL DEFAULT 0,
    eula_accepted_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS retired_slugs (slug TEXT PRIMARY KEY, retired_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS rate_limits (key TEXT PRIMARY KEY, win INTEGER NOT NULL, count INTEGER NOT NULL)`,
];

let schemaReady = false;
async function ensureSchema(db) {
  if (schemaReady) return;
  await db.batch(SCHEMA.map((sql) => db.prepare(sql)));
  schemaReady = true;
}

// ---------------------------------------------------------------- helpers

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Manage-Key, Authorization",
  "Access-Control-Max-Age": "600",
};

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...CORS, ...extra },
  });
}
const err = (status, message) => json({ error: message }, status);
const noContent = () => new Response(null, { status: 204, headers: CORS });

function randomHex(nBytes) {
  const b = crypto.getRandomValues(new Uint8Array(nBytes));
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(s) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function readJSON(request) {
  const text = await request.text();
  if (text.length > 64 * 1024) throw new Error("body too large");
  return JSON.parse(text || "null");
}

const clientIP = (request) => request.headers.get("CF-Connecting-IP") || "local";
const now = () => new Date().toISOString();

// Fixed-window rate limit stored in D1. Returns true if allowed.
async function allow(env, key, max, windowSec) {
  const win = Math.floor(Date.now() / 1000 / windowSec);
  const row = await env.DB.prepare(
    `INSERT INTO rate_limits (key, win, count) VALUES (?1, ?2, 1)
     ON CONFLICT(key) DO UPDATE SET
       count = CASE WHEN rate_limits.win = excluded.win THEN rate_limits.count + 1 ELSE 1 END,
       win = excluded.win
     RETURNING count`
  ).bind(key, win).first();
  return row.count <= max;
}

// ---------------------------------------------------------------- validation

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/;
const RESERVED = new Set(["www", "api", "mc", "admin", "mail", "ftp", "ns1", "ns2", "root", "mzforge",
  "download", "status", "allocate", "test"]);

function slugProblem(slug) {
  if (!SLUG_RE.test(slug)) return "slug must be 3-32 characters: lowercase letters, digits, and hyphens only, and can't start or end with a hyphen";
  if (RESERVED.has(slug)) return `"${slug}" is a reserved name`;
  return null;
}

function cleanName(raw) {
  const name = String(raw ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!name) return [null, "name can't be empty"];
  if ([...name].length > 48) return [null, "name must be 48 characters or fewer"];
  return [name, null];
}

const LOADERS = new Set(["vanilla", "paper", "fabric"]);
const VERSION_RE = /^[0-9]{1,2}\.[0-9]{1,2}(\.[0-9]{1,2})?$/;
const FALLBACK_VERSIONS = ["1.21.8", "1.21.7", "1.21.6", "1.21.5", "1.21.4", "1.21.1",
  "1.20.6", "1.20.4", "1.20.1", "1.19.4", "1.18.2", "1.16.5", "1.12.2"];

async function slugTaken(env, slug) {
  const r = await env.DB.prepare(
    `SELECT 1 FROM servers WHERE slug = ?1 UNION ALL SELECT 1 FROM retired_slugs WHERE slug = ?1 LIMIT 1`
  ).bind(slug).first();
  return !!r;
}

// ---------------------------------------------------------------- Mojang metadata

const MANIFEST = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";

async function mojangReleases() {
  try {
    const res = await fetch(MANIFEST, { cf: { cacheTtl: 21600, cacheEverything: true } });
    if (!res.ok) return null;
    const m = await res.json();
    const rel = (m.versions || []).filter((v) => v.type === "release");
    return rel.length ? rel : null;
  } catch {
    return null;
  }
}

async function versionValid(version) {
  if (!VERSION_RE.test(version)) return false;
  const rel = await mojangReleases();
  if (!rel) return true; // can't check right now; the pattern is the floor
  return rel.some((v) => v.id === version);
}

async function vanillaJarURL(version) {
  const rel = await mojangReleases();
  const entry = rel?.find((v) => v.id === version);
  if (!entry) return "";
  try {
    const res = await fetch(entry.url, { cf: { cacheTtl: 86400, cacheEverything: true } });
    const meta = await res.json();
    const url = meta?.downloads?.server?.url || "";
    return url.startsWith("https://") ? url : "";
  } catch {
    return "";
  }
}

function javaRequirement(version) {
  const [maj, minS, patchS] = version.split(".");
  if (maj !== "1") return "Java 21 or newer (check the release notes for this version)";
  const minor = +minS, patch = +(patchS || 0);
  if (minor > 20 || (minor === 20 && patch >= 5)) return "Java 21";
  if (minor >= 18) return "Java 17";
  if (minor === 17) return "Java 16 or 17";
  return "Java 8";
}

async function jarSource(loader, version) {
  const js = { loader, version, java: javaRequirement(version) };
  if (loader === "paper") {
    Object.assign(js, { source_name: "PaperMC", page_url: "https://papermc.io/downloads/paper",
      instruction: `Download the Paper build for ${version}, rename the file to server.jar, and put it next to MZForgeLauncher.exe.` });
  } else if (loader === "fabric") {
    Object.assign(js, { source_name: "FabricMC", page_url: "https://fabricmc.net/use/server/",
      instruction: `Pick Minecraft ${version}, download the executable server jar, rename it to server.jar, and put it next to MZForgeLauncher.exe. Mods go in a "mods" folder next to it.` });
  } else {
    Object.assign(js, { source_name: "Mojang", page_url: "https://www.minecraft.net/en-us/download/server",
      direct_url: await vanillaJarURL(version),
      instruction: `Download the official Minecraft ${version} server file (it's already called server.jar) and put it next to MZForgeLauncher.exe.` });
  }
  return js;
}

// ---------------------------------------------------------------- Cloudflare DNS

const testMode = (env) => !env.CF_API_TOKEN || !env.CF_ZONE_ID;

async function cfCreateCNAME(env, name, target, comment) {
  if (testMode(env)) return "test-mode-no-record";
  const res = await fetch(`https://api.cloudflare.com/client/v4/zones/${env.CF_ZONE_ID}/dns_records`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.CF_API_TOKEN}`, "Content-Type": "application/json" },
    // name is the FULL hostname; proxied MUST be false (Cloudflare's proxy doesn't speak Minecraft)
    body: JSON.stringify({ type: "CNAME", name, content: target, ttl: 1, proxied: false, comment }),
  });
  const r = await res.json().catch(() => ({}));
  if (!r.success) throw new Error(r.errors?.[0]?.message || `Cloudflare HTTP ${res.status}`);
  return r.result.id;
}

async function cfDeleteRecord(env, id) {
  if (testMode(env) || !id || id === "test-mode-no-record") return;
  const res = await fetch(`https://api.cloudflare.com/client/v4/zones/${env.CF_ZONE_ID}/dns_records/${id}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${env.CF_API_TOKEN}` },
  });
  const r = await res.json().catch(() => ({}));
  if (!r.success) {
    const msg = r.errors?.[0]?.message || `Cloudflare HTTP ${res.status}`;
    // A record someone already removed by hand shouldn't block deleting the server.
    if (!/does not exist|not found/i.test(msg) && res.status !== 404) throw new Error(msg);
  }
}

// ---------------------------------------------------------------- live status
//
// The launcher announces "online" once and "offline" on clean shutdown,
// with no heartbeat. So an announced-online server is re-checked with a
// real Minecraft ping (cached 30s) and only shown online if it answers with
// the version the launcher verified. If Cloudflare won't let the Worker
// connect to that address at all, we can't check, so we trust the
// launcher's announcement rather than wrongly showing "offline".

async function liveStatus(env, rec) {
  if (rec.status === "offline") return { status: "offline" };
  if (rec.status !== "online") return { status: "never_started" };
  if (env.LIVE_PING === "false") return { status: "online", version: rec.verified_version };

  if (Date.now() - rec.checked_at < 30_000 && rec.live_status) {
    return { status: rec.live_status, version: rec.live_version };
  }
  let status = "offline", version = "";
  try {
    const r = await mcPing(rec.hostname, 25565, 4000);
    if (!rec.verified_version || r.versionName === rec.verified_version) {
      status = "online";
      version = r.versionName;
    }
  } catch (e) {
    if (e.unreachableFromWorkers) { status = "online"; version = rec.verified_version; }
  }
  await env.DB.prepare(`UPDATE servers SET live_status = ?1, live_version = ?2, checked_at = ?3 WHERE server_id = ?4`)
    .bind(status, version, Date.now(), rec.server_id).run();
  return { status, version };
}

async function view(env, rec, owned) {
  const ls = await liveStatus(env, rec);
  const v = {
    server_id: rec.server_id,
    name: rec.display_name,
    slug: rec.slug,
    hostname: rec.hostname,
    custom_hostname: rec.custom_hostname,
    loader: rec.loader,
    mc_version: rec.mc_version,
    status: ls.status,
    live_version: ls.version || undefined,
    last_seen: rec.last_seen || undefined,
    owned,
  };
  if (owned) v.created_at = rec.created_at;
  return v;
}

// ---------------------------------------------------------------- download files
//
// The browser zips these together with /MZForgeLauncher.exe.

function downloadFiles(rec, apiBase, jar, manageURL) {
  const properties =
    `server-id=${rec.server_id}\nserver-token=${rec.server_token}\nhostname=${rec.hostname}\nmc-port=25565\n` +
    `api-base=${apiBase}\nconnect-endpoint=${rec.connect_endpoint}\nloader=${rec.loader}\nmc-version=${rec.mc_version}\n`;
  const loaderName = { paper: "Paper", fabric: "Fabric", vanilla: "Vanilla" }[rec.loader] || rec.loader;
  let getJar = `${jar.instruction}\n   From ${jar.source_name}: ${jar.page_url}`;
  if (jar.direct_url) getJar += `\n   Direct link (official Mojang file): ${jar.direct_url}`;
  const readme = `MZForge server: ${rec.display_name}
Minecraft ${rec.mc_version} (${loaderName})

Address to share with friends (works right now):
    ${rec.hostname}

BEFORE THE FIRST RUN
1. Install ${jar.java} if you don't have it (https://adoptium.net is free).
2. Get server.jar. MZForge doesn't include it: the launcher runs the
   official file from the project that makes it, not a copy from us.
   ${getJar}
3. Double-click MZForgeLauncher.exe and keep its window open.
   When it prints SERVER ONLINE, friends can join.

Your server only exists while MZForgeLauncher.exe is running on this PC.
Closing the window (or shutting down / sleeping the PC) takes it offline.

Reserved for later: ${rec.custom_hostname}
That branded address isn't live yet. Minekube (the free tunnel network
MZForge uses) needs a manual step on their side per server, and we're
working with them on automating it. Keep using the address above.

MANAGE THIS SERVER (rename, download again, delete, check status):
    ${manageURL}
There are no MZForge accounts: this link is the key to your server.
Anyone who has it can delete the server, so don't share it. Share the
join address instead.

Keep mzforge.properties private too: it contains this server's secret token.
`.replace(/\r?\n/g, "\r\n");
  return {
    filename: `mzforge-${rec.slug}.zip`,
    files: { "mzforge.properties": properties, "eula.txt": "eula=true\n", "README.txt": readme },
  };
}

function webBase(env, url) {
  return (env.PUBLIC_WEB_URL || url.origin).replace(/\/+$/, "");
}

// ---------------------------------------------------------------- handlers

async function handleAllocate(request, env, url) {
  let req;
  try { req = await readJSON(request); } catch { return err(400, "invalid JSON body"); }
  const slug = String(req?.slug ?? "").trim().toLowerCase();
  const loader = String(req?.loader ?? "").trim().toLowerCase();
  const mcVersion = String(req?.mc_version ?? "").trim();

  const problem = slugProblem(slug);
  if (problem) return err(400, problem);
  if (req.eula_accepted !== true) return err(400, "eula_accepted must be true — the website must show Mojang's EULA and require explicit acceptance");
  if (!LOADERS.has(loader)) return err(400, "loader must be vanilla, paper, or fabric");
  if (!(await versionValid(mcVersion))) return err(400, "unknown Minecraft version");
  let displayName = slug;
  if (String(req.name ?? "").trim()) {
    const [n, e] = cleanName(req.name);
    if (e) return err(400, e);
    displayName = n;
  }
  if (await slugTaken(env, slug)) return err(409, `"${slug}" is already in use, pick another name`);

  // No accounts, so the spam brake is per network.
  const perDay = parseInt(env.MAX_CREATIONS_PER_DAY || "5", 10);
  if (!(await allow(env, `create:${clientIP(request)}`, perDay, 86400))) {
    return err(429, "too many servers created from this network today — try again tomorrow");
  }

  const serverId = randomHex(8);
  const serverToken = randomHex(32);
  const manageKey = randomHex(24);
  const domain = env.MZFORGE_DOMAIN || "mzforge.com";
  const rec = {
    server_id: serverId,
    server_token: serverToken,
    manage_key_hash: await sha256Hex(manageKey),
    slug,
    display_name: displayName,
    // The join address is built from the chosen name. The "mzf-" prefix keeps
    // us clear of names other Minekube users pick. serverId stays random.
    connect_endpoint: `mzf-${slug}`,
    hostname: `mzf-${slug}.play.minekube.net`,
    custom_hostname: `${slug}.mc.${domain}`,
    loader,
    mc_version: mcVersion,
    eula_accepted_at: now(),
    created_at: now(),
  };

  // Insert first: the UNIQUE(slug) constraint settles races between two
  // simultaneous requests for the same name.
  try {
    await env.DB.prepare(
      `INSERT INTO servers (server_id, server_token, manage_key_hash, slug, display_name, hostname, custom_hostname,
         connect_endpoint, loader, mc_version, eula_accepted_at, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`
    ).bind(rec.server_id, rec.server_token, rec.manage_key_hash, rec.slug, rec.display_name, rec.hostname,
      rec.custom_hostname, rec.connect_endpoint, rec.loader, rec.mc_version, rec.eula_accepted_at, rec.created_at).run();
  } catch (e) {
    if (/UNIQUE/i.test(String(e))) return err(409, `"${slug}" is already in use, pick another name`);
    throw e;
  }

  // Reserve the branded CNAME (not live until Minekube supports custom domains via API).
  try {
    const recordId = await cfCreateCNAME(env, rec.custom_hostname, rec.hostname, `MZForge server ${serverId}`);
    await env.DB.prepare(`UPDATE servers SET cf_record_id = ?1 WHERE server_id = ?2`).bind(recordId, serverId).run();
  } catch (e) {
    console.log(`cloudflare error for ${slug}: ${e.message}`);
    await env.DB.prepare(`DELETE FROM servers WHERE server_id = ?1`).bind(serverId).run();
    return err(502, "could not create the DNS record — try again in a moment");
  }

  const jar = await jarSource(loader, mcVersion);
  const manageURL = `${webBase(env, url)}/#/manage/${serverId}/${manageKey}`;
  return json({
    server_id: serverId,
    hostname: rec.hostname,
    custom_hostname: rec.custom_hostname,
    connect_endpoint: rec.connect_endpoint,
    manage_key: manageKey, // only ever returned here
    download: downloadFiles(rec, url.origin, jar, manageURL),
  });
}

// Loads {id} and checks X-Manage-Key. Wrong key and unknown id look the same.
async function managed(request, env, id) {
  const ip = clientIP(request);
  if (!(await allow(env, `manage:${ip}`, 120, 60))) return [null, null, err(429, "slow down")];
  const key = request.headers.get("X-Manage-Key") || "";
  const rec = await env.DB.prepare(`SELECT * FROM servers WHERE server_id = ?1`).bind(id).first();
  if (!rec || !key || !safeEqual(await sha256Hex(key), rec.manage_key_hash)) {
    if (!(await allow(env, `badkey:${ip}`, 30, 3600))) return [null, null, err(429, "too many wrong manage links — try again later")];
    return [null, null, err(404, "server not found, or this manage link isn't valid for it")];
  }
  return [rec, key, null];
}

async function handleServer(request, env, url, id, sub) {
  const [rec, key, fail] = await managed(request, env, id);
  if (fail) return fail;

  if (sub === "files" && request.method === "POST") {
    if (!(await allow(env, `download:${id}`, 30, 3600))) return err(429, "too many downloads — try again later");
    const jar = await jarSource(rec.loader, rec.mc_version);
    const manageURL = `${webBase(env, url)}/#/manage/${rec.server_id}/${key}`;
    return json({ server_id: rec.server_id, download: downloadFiles(rec, url.origin, jar, manageURL) });
  }
  if (sub) return err(404, "not found");

  if (request.method === "GET") return json(await view(env, rec, true));

  if (request.method === "PATCH") {
    let req;
    try { req = await readJSON(request); } catch { return err(400, "invalid JSON body"); }
    const [name, e] = cleanName(req?.name);
    if (e) return err(400, e);
    await env.DB.prepare(`UPDATE servers SET display_name = ?1 WHERE server_id = ?2`).bind(name, id).run();
    rec.display_name = name;
    return json(await view(env, rec, true));
  }

  if (request.method === "DELETE") {
    try {
      await cfDeleteRecord(env, rec.cf_record_id);
    } catch (e) {
      console.log(`delete ${id}: cloudflare: ${e.message}`);
      return err(502, "could not remove the DNS record — nothing was deleted, try again in a moment");
    }
    // Retire the name: Minekube ties an endpoint name to the PC that first
    // used it, so it must never be handed to someone new.
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM servers WHERE server_id = ?1`).bind(id),
      env.DB.prepare(`INSERT OR IGNORE INTO retired_slugs (slug, retired_at) VALUES (?1, ?2)`).bind(rec.slug, now()),
    ]);
    return noContent();
  }
  return err(405, "method not allowed");
}

async function handleStatus(request, env, url) {
  const id = url.searchParams.get("server_id");
  if (!id) return err(400, "missing server_id query param");
  if (!(await allow(env, `status:${clientIP(request)}`, 240, 60))) return err(429, "slow down");
  const rec = await env.DB.prepare(`SELECT * FROM servers WHERE server_id = ?1`).bind(id).first();
  if (!rec) return err(404, "unknown server_id");
  const v = await view(env, rec, false);
  return json({
    server_id: v.server_id,
    hostname: v.hostname,
    status: v.status,
    verified_version: rec.verified_version,
    last_seen: rec.last_seen,
    server: v,
  });
}

async function launcherAuth(request, env, serverId) {
  const rec = await env.DB.prepare(`SELECT * FROM servers WHERE server_id = ?1`).bind(serverId || "").first();
  if (!rec) return [null, err(404, "unknown server_id")];
  const auth = (request.headers.get("Authorization") || "").replace(/^Bearer /, "");
  if (!safeEqual(auth, rec.server_token)) return [null, err(401, "invalid or missing token")];
  return [rec, null];
}

async function handleAnnounce(request, env) {
  let req;
  try { req = await readJSON(request); } catch { return err(400, "invalid JSON body"); }
  const [rec, fail] = await launcherAuth(request, env, req?.server_id);
  if (fail) return fail;
  if (req.status !== "online" && req.status !== "offline") return err(400, `status must be "online" or "offline"`);
  await env.DB.prepare(
    `UPDATE servers SET status = ?1, last_seen = ?2,
       verified_version = CASE WHEN ?3 != '' THEN ?3 ELSE verified_version END,
       checked_at = 0, live_status = ''
     WHERE server_id = ?4`
  ).bind(req.status, now(), String(req.verified_version || ""), rec.server_id).run();
  return new Response(null, { status: 204 });
}

async function handleProbe(request, env) {
  let req;
  try { req = await readJSON(request); } catch { return err(400, "invalid JSON body"); }
  const [rec, fail] = await launcherAuth(request, env, req?.server_id);
  if (fail) return fail;
  const start = Date.now();
  try {
    // Always probe the server's own address, whatever hostname was sent,
    // so this can't be used to make the Worker ping arbitrary hosts.
    const r = await mcPing(rec.hostname, 25565, 8000);
    return json({ reachable: true, latency_ms: Date.now() - start, detail: `version: ${r.versionName}` });
  } catch (e) {
    return json({ reachable: false, latency_ms: Date.now() - start, detail: e.message });
  }
}

async function handleSlugAvailable(request, env, url) {
  if (!(await allow(env, `slug:${clientIP(request)}`, 120, 60))) return err(429, "slow down");
  const slug = String(url.searchParams.get("slug") || "").trim().toLowerCase();
  const problem = slugProblem(slug);
  if (problem) return json({ slug, available: false, reason: problem });
  if (await slugTaken(env, slug)) return json({ slug, available: false, reason: "already taken" });
  return json({ slug, available: true, join_address: `mzf-${slug}.play.minekube.net` });
}

async function handleVersions() {
  const rel = await mojangReleases();
  return json(
    { versions: rel ? rel.slice(0, 40).map((v) => v.id) : FALLBACK_VERSIONS, source: rel ? "mojang" : "builtin", loaders: [...LOADERS] },
    200,
    { "Cache-Control": "public, max-age=600" }
  );
}

async function handleJarSource(url) {
  const loader = url.searchParams.get("loader") || "";
  const version = url.searchParams.get("version") || "";
  if (!LOADERS.has(loader) || !VERSION_RE.test(version)) return err(400, "unknown loader or version");
  return json(await jarSource(loader, version));
}

function handleEula(env) {
  const out = { url: "https://aka.ms/MinecraftEULA" };
  if (env.EULA_TEXT) out.text = env.EULA_TEXT;
  return json(out, 200, { "Cache-Control": "public, max-age=3600" });
}

// ---------------------------------------------------------------- router

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.pathname;
    const m = request.method;
    if (m === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    try {
      await ensureSchema(env.DB);

      if (p === "/announce" && m === "POST") return await handleAnnounce(request, env);
      if (p === "/probe" && m === "POST") return await handleProbe(request, env);
      if (p === "/status" && m === "GET") return await handleStatus(request, env, url);
      if (p === "/allocate" && m === "POST") return await handleAllocate(request, env, url);
      if (p === "/slug-available" && m === "GET") return await handleSlugAvailable(request, env, url);
      if (p === "/meta/versions" && m === "GET") return await handleVersions();
      if (p === "/meta/server-jar" && m === "GET") return await handleJarSource(url);
      if (p === "/meta/eula" && m === "GET") return handleEula(env);
      if (p === "/meta/mode" && m === "GET") return json({ test_mode: testMode(env) });

      const sm = p.match(/^\/servers\/([a-f0-9]{16})(?:\/(files))?$/);
      if (sm) return await handleServer(request, env, url, sm[1], sm[2]);

      // Anything else: the website (index.html, MZForgeLauncher.exe, ...).
      if (env.ASSETS) return env.ASSETS.fetch(request);
      return err(404, "not found");
    } catch (e) {
      console.log(`unhandled error on ${m} ${p}: ${e.stack || e}`);
      return err(500, "something went wrong on our side — try again in a moment");
    }
  },
};
