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

// Columns added after the first release. Added in place on existing
// databases, so a deployed MZForge upgrades itself on the next request.
const ADDED_COLUMNS = {
  expires_at: `TEXT NOT NULL DEFAULT ''`,
  motd: `TEXT NOT NULL DEFAULT ''`,
  max_players: `INTEGER NOT NULL DEFAULT 20`,
  pvp: `INTEGER NOT NULL DEFAULT 1`,
  gamemode: `TEXT NOT NULL DEFAULT 'survival'`,
  difficulty: `TEXT NOT NULL DEFAULT 'easy'`,
  mods: `TEXT NOT NULL DEFAULT '[]'`,
  view_distance: `INTEGER NOT NULL DEFAULT 10`,
  simulation_distance: `INTEGER NOT NULL DEFAULT 10`,
  connect_token: `TEXT NOT NULL DEFAULT ''`,
  probe_fails: `INTEGER NOT NULL DEFAULT 0`,
  connector: `TEXT NOT NULL DEFAULT 'gate'`,
  ram_mb: `INTEGER NOT NULL DEFAULT 4096`,
  port: `INTEGER NOT NULL DEFAULT 25565`,
  whitelist: `INTEGER NOT NULL DEFAULT 0`,
  whitelist_players: `TEXT NOT NULL DEFAULT '[]'`,
  ops: `TEXT NOT NULL DEFAULT '[]'`,
  online_mode: `INTEGER NOT NULL DEFAULT 0`,
  icon: `TEXT NOT NULL DEFAULT ''`,
};

let schemaReady = false;
async function ensureSchema(db) {
  if (schemaReady) return;
  await db.batch(SCHEMA.map((sql) => db.prepare(sql)));
  const { results } = await db.prepare(`PRAGMA table_info(servers)`).all();
  const have = new Set(results.map((c) => c.name));
  for (const [col, type] of Object.entries(ADDED_COLUMNS)) {
    if (!have.has(col)) await db.prepare(`ALTER TABLE servers ADD COLUMN ${col} ${type}`).run();
  }
  // Servers created before expiry existed get a fresh 30 days, not instant deletion.
  await db.prepare(`UPDATE servers SET expires_at = ?1 WHERE expires_at = ''`).bind(inDays(RENEW_DAYS)).run();
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

// ---------------------------------------------------------------- expiry
//
// A server's address is held for 30 days. Clicking Renew, or the launcher
// reporting the server online (someone is actually using it), restarts the
// 30 days. A daily cron removes servers past expires_at and frees the name.
const RENEW_DAYS = 30;
const DAY_MS = 86_400_000;
const inDays = (n) => new Date(Date.now() + n * DAY_MS).toISOString();
const isExpired = (rec) => !!rec.expires_at && Date.parse(rec.expires_at) <= Date.now();
const daysLeft = (rec) => Math.max(0, Math.ceil((Date.parse(rec.expires_at) - Date.now()) / DAY_MS));

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

// Paper uses Minekube's official in-server Connect plugin by default. Gate is
// reserved for loaders that cannot host that plugin. Keep this decision on the
// server side so old D1 rows with connector=gate cannot make new downloads pick
// the wrong topology.
function effectiveConnector(rec) {
  return rec?.loader === "paper" ? "plugin" : "gate";
}

// ---------------------------------------------------------------- server settings

const GAMEMODES = new Set(["survival", "creative", "adventure"]);
const DIFFICULTIES = new Set(["peaceful", "easy", "normal", "hard"]);

// Validates the settings fields present in req. Returns [updates, error].
function parseSettings(req) {
  const u = {};
  if ("motd" in req) {
    // Minecraft shows at most two lines, so keep real newlines (they become
    // \u000a in server.properties) but drop every other control character.
    const lines = String(req.motd ?? "").replace(/\r\n?/g, "\n").split("\n").slice(0, 2)
      .map((l) => l.replace(/[\u0000-\u001f\u007f]/g, " ").trim());
    const motd = lines.join("\n").trim();
    if ([...motd].length > 140) return [null, "description must be 140 characters or fewer"];
    u.motd = motd;
  }
  if ("max_players" in req) {
    const n = Number(req.max_players);
    if (!Number.isInteger(n) || n < 1 || n > 500) return [null, "max players must be a whole number from 1 to 500"];
    u.max_players = n;
  }
  if ("pvp" in req) {
    if (typeof req.pvp !== "boolean") return [null, "pvp must be true or false"];
    u.pvp = req.pvp ? 1 : 0;
  }
  if ("gamemode" in req) {
    if (!GAMEMODES.has(req.gamemode)) return [null, "game mode must be survival, creative, or adventure"];
    u.gamemode = req.gamemode;
  }
  if ("difficulty" in req) {
    if (!DIFFICULTIES.has(req.difficulty)) return [null, "difficulty must be peaceful, easy, normal, or hard"];
    u.difficulty = req.difficulty;
  }
  for (const [field, min, max] of [["view_distance", 3, 32], ["simulation_distance", 3, 32]]) {
    if (!(field in req)) continue;
    const n = Number(req[field]);
    if (!Number.isInteger(n) || n < min || n > max) return [null, `${field.replace("_", " ")} must be a whole number from ${min} to ${max}`];
    u[field] = n;
  }
  if ("connector" in req) {
    if (!["gate", "plugin"].includes(req.connector)) return [null, "connector must be gate or plugin"];
    u.connector = req.connector;
  }
  if ("connect_token" in req) {
    const t = String(req.connect_token ?? "").trim();
    if (t && !/^[\w.\-]{8,300}$/.test(t)) return [null, "that doesn't look like a Minekube Connect token"];
    u.connect_token = t;
  }
  if ("ram_mb" in req) {
    const n = Number(req.ram_mb);
    if (!Number.isInteger(n) || n < 1024 || n > 32768 || n % 256 !== 0) return [null, "memory must be between 1 GB and 32 GB"];
    u.ram_mb = n;
  }
  if ("port" in req) {
    const n = Number(req.port);
    if (!Number.isInteger(n) || n < 1024 || n > 65535) return [null, "port must be a number from 1024 to 65535"];
    u.port = n;
  }
  if ("whitelist" in req) {
    if (typeof req.whitelist !== "boolean") return [null, "whitelist must be true or false"];
    u.whitelist = req.whitelist ? 1 : 0;
  }
  if ("online_mode" in req) {
    if (typeof req.online_mode !== "boolean") return [null, "online_mode must be true or false"];
    u.online_mode = req.online_mode ? 1 : 0;
  }
  for (const [field, max] of [["whitelist_players", 200], ["ops", 20]]) {
    if (!(field in req)) continue;
    if (!Array.isArray(req[field]) || req[field].length > max) return [null, `${field === "ops" ? "admins" : "whitelist"}: up to ${max} names`];
    const names = [];
    for (const n of req[field]) {
      const name = String(typeof n === "object" && n ? n.name : n).trim();
      if (!MC_NAME.test(name)) return [null, `"${name}" isn't a valid Minecraft username (3-16 letters, numbers or _)`];
      if (!names.some((x) => x.toLowerCase() === name.toLowerCase())) names.push(name);
    }
    u[field] = names; // resolved to UUIDs by resolvePlayers()
  }
  return [u, null];
}

const MC_NAME = /^[A-Za-z0-9_]{3,16}$/;
const dashed = (hex) => `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;

// Official accounts: look the name up with Mojang (also catches typos).
// Returns { name, uuid } with Mojang's capitalisation, or null if no such account.
async function mojangPlayer(env, name) {
  const base = env.MOJANG_API || "https://api.mojang.com/users/profiles/minecraft/";
  const res = await fetch(base + encodeURIComponent(name), { cf: { cacheTtl: 3600, cacheEverything: true } });
  if (res.status === 404 || res.status === 204) return null;
  if (!res.ok) throw new Error(`Mojang HTTP ${res.status}`);
  const j = await res.json().catch(() => null);
  if (!j?.id || !/^[0-9a-f]{32}$/i.test(j.id)) return null;
  return { name: j.name, uuid: dashed(j.id.toLowerCase()) };
}

// Cracked/offline servers identify players by a UUID derived from the name
// (Java's UUID.nameUUIDFromBytes("OfflinePlayer:" + name), an MD5 v3 UUID).
async function offlineUUID(name) {
  const h = new Uint8Array(await crypto.subtle.digest("MD5", new TextEncoder().encode("OfflinePlayer:" + name)));
  h[6] = (h[6] & 0x0f) | 0x30;
  h[8] = (h[8] & 0x3f) | 0x80;
  return dashed([...h].map((b) => b.toString(16).padStart(2, "0")).join(""));
}

// Turns name lists into stored [{name, uuid}] entries. Official-account
// servers need real Mojang accounts; cracked ones accept any valid name.
async function resolvePlayers(env, names, online, previous = []) {
  const out = [];
  for (const name of names) {
    const known = previous.find((p) => p.name.toLowerCase() === name.toLowerCase() && p.uuid);
    if (online) {
      if (known) { out.push(known); continue; }
      const p = await mojangPlayer(env, name);
      if (!p) throw new UserError(`there's no Minecraft account called "${name}". Check the spelling, or switch to cracked mode`);
      out.push(p);
    } else {
      out.push({ name: known?.name || name, uuid: known?.uuid || "" });
    }
  }
  return out;
}
class UserError extends Error {}
const parseList = (text) => { try { return JSON.parse(text || "[]"); } catch { return []; } };

// Entries for whitelist.json / ops.json, with the UUID the server will
// actually see for its current account type.
async function playerFileEntries(rec, field) {
  const online = !!rec.online_mode;
  const out = [];
  for (const p of parseList(rec[field])) {
    const uuid = online ? p.uuid : await offlineUUID(p.name);
    if (!uuid) continue;
    out.push(field === "ops" ? { uuid, name: p.name, level: 4, bypassesPlayerLimit: false } : { uuid, name: p.name });
  }
  return out;
}

// ---------------------------------------------------------------- server icon
// Minecraft only shows server-icon.png if it's a 64x64 PNG. The website
// resizes uploads in the browser; this double-checks before storing.
function validIcon(b64) {
  if (typeof b64 !== "string" || b64.length > 90_000) return false;
  let bin;
  try { bin = atob(b64); } catch { return false; }
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bin.length < 33 || !sig.every((c, i) => bin.charCodeAt(i) === c) || bin.slice(12, 16) !== "IHDR") return false;
  const u32 = (o) => ((bin.charCodeAt(o) << 24) | (bin.charCodeAt(o + 1) << 16) | (bin.charCodeAt(o + 2) << 8) | bin.charCodeAt(o + 3)) >>> 0;
  return u32(16) === 64 && u32(20) === 64;
}

// Java .properties value escaping. Minecraft has read server.properties as
// ISO-8859-1 or UTF-8 depending on version, so anything non-ASCII is written
// as \uXXXX, which every version reads correctly. "&" colour codes
// (&6Gold, &lBold) become Minecraft's section-sign codes.
function propValue(v) {
  const colored = String(v).replace(/&([0-9a-fk-or])/gi, "\u00a7$1");
  let out = "";
  for (const ch of colored) {
    const cp = ch.codePointAt(0);
    if (ch === "\\") out += "\\\\";
    else if (cp >= 0x20 && cp < 0x7f) out += ch;
    else if (cp < 0x10000) out += "\\u" + cp.toString(16).padStart(4, "0");
    else { // surrogate pair
      const c = cp - 0x10000;
      out += "\\u" + (0xd800 + (c >> 10)).toString(16) + "\\u" + (0xdc00 + (c & 0x3ff)).toString(16);
    }
  }
  return out.replace(/^([ #!])/, "\\$1"); // keep a leading space/#/! from being eaten
}

// The keys MZForge manages. The launcher applies these same values on
// every start, leaving every other line of server.properties alone.
function managedProperties(rec) {
  return {
    motd: propValue(rec.motd || rec.display_name),
    "max-players": String(rec.max_players),
    pvp: rec.pvp ? "true" : "false",
    gamemode: rec.gamemode,
    difficulty: rec.difficulty,
    "server-port": String(rec.port || 25565),
    "view-distance": String(rec.view_distance || 10),
    "simulation-distance": String(rec.simulation_distance || 10),
    "white-list": rec.whitelist ? "true" : "false",
    "enforce-whitelist": rec.whitelist ? "true" : "false",
    // Connector topology matters here. With the Connect plugin installed
    // directly in Paper, Minekube documents Paper in online mode and the
    // plugin handles both authenticated identities and the explicit
    // allow-offline-mode-players opt-in. Gate, on the other hand, proxies
    // into an offline-mode backend. The website account-type switch remains
    // rec.online_mode; it is NOT the same thing as Paper's online-mode.
    "online-mode": effectiveConnector(rec) === "plugin" ? "true" : "false",
    "enforce-secure-profile": "false",
  };
}

function serverPropertiesFile(rec) {
  const lines = ["#Minecraft server properties", "#Generated by MZForge. motd, max-players, pvp, gamemode, difficulty, server-port,",
    "#authentication policy and white-list are set on the website and re-applied by",
    "#MZForgeLauncher.exe on every start.",
    "#Everything else can be edited here; Minecraft adds the remaining defaults on first run."];
  for (const [k, v] of Object.entries(managedProperties(rec))) lines.push(`${k}=${v}`);
  return lines.join("\n") + "\n";
}
const VERSION_RE = /^[0-9]{1,2}\.[0-9]{1,2}(\.[0-9]{1,2})?$/;
const FALLBACK_VERSIONS = ["1.21.8", "1.21.7", "1.21.6", "1.21.5", "1.21.4", "1.21.1",
  "1.20.6", "1.20.4", "1.20.1", "1.19.4", "1.18.2", "1.16.5", "1.12.2"];

async function slugTaken(env, slug) {
  const r = await env.DB.prepare(
    `SELECT 1 FROM servers WHERE slug = ?1 UNION ALL SELECT 1 FROM retired_slugs WHERE slug = ?1 LIMIT 1`
  ).bind(slug).first();
  return !!r;
}

// ---------------------------------------------------------------- mods & plugins (Modrinth)
//
// The website searches Modrinth directly. To add a mod it sends only a
// Modrinth version id; the Worker fetches that version from Modrinth itself
// and checks loader + Minecraft version before saving, so a stored download
// URL always comes from Modrinth's own CDN, never from the client.

const MODRINTH = "https://api.modrinth.com/v2";
const MOD_LOADERS = { fabric: ["fabric"], paper: ["paper", "spigot", "bukkit"] };
const MAX_MODS = 60;
const modsFolder = (loader) => (loader === "fabric" ? "mods" : loader === "paper" ? "plugins" : "");
function parseMods(rec) {
  try { return JSON.parse(rec.mods || "[]"); } catch { return []; }
}

async function modrinth(env, path) {
  const res = await fetch((env.MODRINTH_API || MODRINTH) + path, {
    headers: { "User-Agent": "MZForge/1.0 (Minecraft server hosting dashboard)" },
    cf: { cacheTtl: 300, cacheEverything: true },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Modrinth HTTP ${res.status}`);
  return res.json();
}

async function handleMods(request, env, rec, modId) {
  const loaders = MOD_LOADERS[rec.loader];
  if (!loaders) return err(400, "Vanilla servers can't run mods or plugins. Create a Paper server for plugins or a Fabric server for mods");
  let mods = parseMods(rec);
  const save = () => env.DB.prepare(`UPDATE servers SET mods = ?1 WHERE server_id = ?2`).bind(JSON.stringify(mods), rec.server_id).run();

  if (request.method === "GET" && !modId) return json({ mods, mods_folder: modsFolder(rec.loader) });

  if (request.method === "DELETE" && modId) {
    mods = mods.filter((m) => m.project_id !== modId);
    await save();
    return json({ mods, mods_folder: modsFolder(rec.loader) });
  }

  if (request.method === "POST" && !modId) {
    if (!(await allow(env, `mods:${rec.server_id}`, 120, 3600))) return err(429, "too many changes — try again in a bit");
    let req;
    try { req = await readJSON(request); } catch { return err(400, "invalid JSON body"); }
    const versionId = String(req?.version_id || "");
    if (!/^[A-Za-z0-9]{1,16}$/.test(versionId)) return err(400, "invalid version_id");

    let v;
    try { v = await modrinth(env, `/version/${versionId}`); } catch { return err(502, "couldn't reach Modrinth — try again in a moment"); }
    if (!v) return err(404, "that version doesn't exist on Modrinth");
    const kind = rec.loader === "fabric" ? "Fabric" : "Paper";
    if (!(v.loaders || []).some((l) => loaders.includes(l))) return err(400, `that version isn't for ${kind}`);
    if (!(v.game_versions || []).includes(rec.mc_version)) return err(400, `that version isn't for Minecraft ${rec.mc_version}`);
    const file = (v.files || []).find((f) => f.primary) || (v.files || [])[0];
    if (!file || !String(file.url).startsWith("https://cdn.modrinth.com/") || !/^[\w.+\-() ]{1,120}\.jar$/.test(file.filename)) {
      return err(400, "that version has no usable .jar file");
    }
    const others = mods.filter((m) => m.project_id !== v.project_id);
    if (others.length >= MAX_MODS) return err(400, `a server can have at most ${MAX_MODS} mods or plugins here`);
    if (others.some((m) => m.filename.toLowerCase() === file.filename.toLowerCase())) return err(409, "another mod already uses that file name");

    let proj = null;
    try { proj = await modrinth(env, `/project/${v.project_id}`); } catch { /* title falls back below */ }
    const entry = {
      project_id: v.project_id,
      version_id: v.id,
      title: proj?.title || file.filename,
      slug: proj?.slug || v.project_id,
      icon_url: String(proj?.icon_url || "").startsWith("https://cdn.modrinth.com/") ? proj.icon_url : "",
      version_number: v.version_number,
      filename: file.filename,
      url: file.url,
      sha512: file.hashes?.sha512 || "",
      size: file.size || 0,
    };
    mods = [...others, entry];
    await save();
    const missing = (v.dependencies || [])
      .filter((d) => d.dependency_type === "required" && d.project_id && !mods.some((m) => m.project_id === d.project_id))
      .map((d) => d.project_id);
    return json({ mods, mods_folder: modsFolder(rec.loader), added: entry, missing_dependencies: [...new Set(missing)] });
  }
  return err(405, "method not allowed");
}

// Mod files are fetched through the Worker so the browser can zip them
// without depending on the CDN's CORS settings. Modrinth's CDN only.
async function handleModFile(request, env, url) {
  if (!(await allow(env, `modfile:${clientIP(request)}`, 600, 3600))) return err(429, "too many downloads — try again later");
  const target = url.searchParams.get("url") || "";
  if (!/^https:\/\/cdn\.modrinth\.com\/data\/[A-Za-z0-9]+\/versions\/[A-Za-z0-9]+\/[^?#]+\.jar$/.test(target)) {
    return err(400, "only Modrinth mod files can be downloaded here");
  }
  // MODRINTH_CDN_TEST: local testing only, points the CDN at a fake server.
  const from = env.MODRINTH_CDN_TEST ? target.replace("https://cdn.modrinth.com", env.MODRINTH_CDN_TEST) : target;
  const res = await fetch(from, { cf: { cacheTtl: 86400, cacheEverything: true } });
  if (!res.ok) return err(502, `couldn't download that file from Modrinth (HTTP ${res.status})`);
  return new Response(res.body, { headers: { "Content-Type": "application/java-archive", "Cache-Control": "public, max-age=86400", ...CORS } });
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

// resolveJar finds the official download for a loader + version, so the
// launcher can fetch server.jar itself on first run. We never re-host these
// files: the URLs point at Mojang, PaperMC and FabricMC themselves.
async function resolveJar(env, loader, version) {
  const bases = {
    paper: env.PAPER_API || "https://api.papermc.io",
    paperFill: env.PAPER_FILL_API || "https://fill.papermc.io",
    fabric: env.FABRIC_META || "https://meta.fabricmc.net",
  };
  try {
    if (loader === "vanilla") {
      const url = await vanillaJarURL(version);
      return url ? { url, filename: `minecraft_server.${version}.jar` } : null;
    }
    if (loader === "paper") {
      // Paper's download block is keyed differently between API versions,
      // so take whichever entry is a .jar rather than assuming a name.
      const pick = (downloads) => {
        const entries = Object.entries(downloads || {});
        const hit = entries.find(([k]) => k === "server:default") || entries.find(([k]) => k === "application") ||
          entries.find(([, d]) => String(d?.name || "").endsWith(".jar"));
        if (!hit) return null;
        const d = hit[1];
        return { name: d.name || "", url: d.url || "", sha256: d.checksums?.sha256 || d.sha256 || "" };
      };
      // Current Fill API first.
      try {
        const r = await (await fetch(`${bases.paperFill}/v3/projects/paper/versions/${version}/builds/latest`,
          { headers: { "User-Agent": "MZForge/1.0 (+https://mzforge.com)" }, cf: { cacheTtl: 900, cacheEverything: true } })).json();
        const d = pick(r?.downloads);
        if (d?.url?.startsWith("https://")) return { url: d.url, sha256: d.sha256, filename: d.name || `paper-${version}.jar` };
      } catch { /* fall through to v2 */ }
      // Older v2 listing.
      const builds = await (await fetch(`${bases.paper}/v2/projects/paper/versions/${version}/builds`,
        { cf: { cacheTtl: 900, cacheEverything: true } })).json();
      const all = builds?.builds || [];
      const last = all.filter((b) => b.channel === "default").pop() || all.pop();
      const d = pick(last?.downloads);
      if (!d?.name) return null;
      return {
        url: d.url || `${bases.paper}/v2/projects/paper/versions/${version}/builds/${last.build}/downloads/${d.name}`,
        sha256: d.sha256, filename: d.name,
      };
    }
    if (loader === "fabric") {
      const loaders = await (await fetch(`${bases.fabric}/v2/versions/loader/${version}`, { cf: { cacheTtl: 3600, cacheEverything: true } })).json();
      const installers = await (await fetch(`${bases.fabric}/v2/versions/installer`, { cf: { cacheTtl: 3600, cacheEverything: true } })).json();
      const lv = loaders?.find((l) => l.loader?.stable)?.loader?.version || loaders?.[0]?.loader?.version;
      const iv = installers?.find((i) => i.stable)?.version || installers?.[0]?.version;
      if (!lv || !iv) return null;
      return { url: `${bases.fabric}/v2/versions/loader/${version}/${lv}/${iv}/server/jar`, filename: `fabric-server-${version}.jar` };
    }
  } catch (e) {
    console.log(`resolveJar(${loader}, ${version}): ${e.message}`);
  }
  return null;
}

// Java version Minecraft needs, as a number (to download a runtime).
function javaMajor(version) {
  const [maj, minS, patchS] = String(version).split(".");
  if (maj !== "1") return 21;
  const minor = +minS, patch = +(patchS || 0);
  if (minor > 20 || (minor === 20 && patch >= 5)) return 21;
  if (minor >= 18) return 17;
  if (minor === 17) return 16;
  return 8;
}

// Official Temurin (Eclipse Adoptium) JRE for Windows x64: a plain redirect
// to their own zip. No API key, no account.
function javaDownload(env, major) {
  return `${env.ADOPTIUM_API || "https://api.adoptium.net"}/v3/binary/latest/${major}/ga/windows/x64/jre/hotspot/normal/eclipse`;
}

async function jarSource(env, loader, version) {
  const js = { loader, version, java: javaRequirement(version), java_major: javaMajor(version) };
  const resolved = await resolveJar(env, loader, version);
  if (resolved) js.direct_url = resolved.url;
  if (loader === "paper") {
    Object.assign(js, { source_name: "PaperMC", page_url: "https://papermc.io/downloads/paper",
      instruction: `The launcher downloads Paper ${version} by itself on the first run. To do it by hand instead: download the Paper build for ${version}, rename it to server.jar, and put it next to MZForgeLauncher.exe.` });
  } else if (loader === "fabric") {
    Object.assign(js, { source_name: "FabricMC", page_url: "https://fabricmc.net/use/server/",
      instruction: `The launcher downloads the Fabric server for ${version} by itself on the first run. To do it by hand instead: pick Minecraft ${version}, download the executable server jar, and rename it to server.jar.` });
  } else {
    Object.assign(js, { source_name: "Mojang", page_url: "https://www.minecraft.net/en-us/download/server",
      instruction: `The launcher downloads the official Minecraft ${version} server file by itself on the first run. To do it by hand instead: download it from Mojang and put it next to MZForgeLauncher.exe as server.jar.` });
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

const HEARTBEAT_GRACE_MS = 3 * 60 * 1000;

async function liveStatus(env, rec) {
  if (rec.status === "offline") return { status: "offline" };
  if (rec.status !== "online") return { status: "never_started" };

  // The launcher checks in every minute while it runs, so a recent
  // check-in is the truth. Pinging the public address is unreliable here:
  // Minekube's tunnel carries players but doesn't always answer
  // server-list pings, which made running servers look offline.
  const since = Date.now() - Date.parse(rec.last_seen || 0);
  if (since >= 0 && since < HEARTBEAT_GRACE_MS) {
    return { status: "online", version: rec.verified_version };
  }

  if (env.LIVE_PING === "false") return { status: "online", version: rec.verified_version };

  if (Date.now() - rec.checked_at < 30_000 && rec.live_status) {
    return { status: rec.live_status, version: rec.live_version };
  }
  // Minekube's edge can be slow to answer, especially for a newly
  // registered endpoint, so: a generous timeout, and one failed ping isn't
  // enough to call a server offline — two in a row are.
  let status = "offline", version = "", fails = (rec.probe_fails || 0) + 1;
  try {
    const r = await mcPing(rec.hostname, 25565, 10000);
    if (!rec.verified_version || r.versionName === rec.verified_version) {
      status = "online";
      version = r.versionName;
      fails = 0;
    }
  } catch (e) {
    if (e.unreachableFromWorkers) { status = "online"; version = rec.verified_version; fails = 0; }
  }
  if (status === "offline" && fails < 2) {
    status = "online"; // still trusting the launcher's own report for now
    version = rec.verified_version;
  }
  await env.DB.prepare(`UPDATE servers SET live_status = ?1, live_version = ?2, checked_at = ?3, probe_fails = ?4 WHERE server_id = ?5`)
    .bind(status, version, Date.now(), fails, rec.server_id).run();
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
    expires_at: rec.expires_at,
    days_left: daysLeft(rec),
    expired: isExpired(rec),
    motd: rec.motd || "",
    owned,
  };
  v.icon_url = `/servers/${rec.server_id}/icon.png${rec.icon ? "?v=" + rec.icon.length.toString(36) + rec.icon.slice(-6).replace(/[^A-Za-z0-9]/g, "") : ""}`;
  v.has_icon = !!rec.icon;
  v.max_players = rec.max_players;
  v.gamemode = rec.gamemode;
  if (owned) {
    Object.assign(v, {
      ram_mb: rec.ram_mb,
      port: rec.port,
      whitelist: !!rec.whitelist,
      view_distance: rec.view_distance,
      simulation_distance: rec.simulation_distance,
      connect_token: rec.connect_token || "",
      connector: effectiveConnector(rec),
      whitelist_players: parseList(rec.whitelist_players).map((p) => p.name),
      ops: parseList(rec.ops).map((p) => p.name),
      online_mode: !!rec.online_mode,
      created_at: rec.created_at,
      max_players: rec.max_players,
      pvp: !!rec.pvp,
      gamemode: rec.gamemode,
      difficulty: rec.difficulty,
      mods: parseMods(rec),
      mods_folder: modsFolder(rec.loader),
    });
  }
  return v;
}

// ---------------------------------------------------------------- download files
//
// The browser zips these together with /MZForgeLauncher.exe.

async function downloadFiles(rec, apiBase, jar, manageURL, webURL) {
  const properties =
    `server-id=${rec.server_id}\nserver-token=${rec.server_token}\nhostname=${rec.hostname}\nmc-port=${rec.port || 25565}\n` +
    `ram=${rec.ram_mb || 4096}M\n` +
    `api-base=${apiBase}\nconnect-endpoint=${rec.connect_endpoint}\nloader=${rec.loader}\nmc-version=${rec.mc_version}\n` +
    `renew-url=${manageURL}\nweb-url=${webURL}\n` +
    `online-mode=${rec.online_mode ? "true" : "false"}\n` +
    `connector=${effectiveConnector(rec)}\n`;
  const mods = parseMods(rec);
  const folder = modsFolder(rec.loader);
  const modsNote = mods.length
    ? `\n${folder === "mods" ? "MODS" : "PLUGINS"} (in the ${folder} folder, from Modrinth):\n` + mods.map((m) => `  - ${m.title} ${m.version_number}`).join("\n") +
      `\nAdd or remove them on your server page. The launcher downloads newly added\nones on start; removed ones you delete from the ${folder} folder yourself.\n`
    : "";
  const loaderName = { paper: "Paper", fabric: "Fabric", vanilla: "Vanilla" }[rec.loader] || rec.loader;
  let getJar = `${jar.instruction}\n   From ${jar.source_name}: ${jar.page_url}`;
  if (jar.direct_url) getJar += `\n   Direct link (official Mojang file): ${jar.direct_url}`;
  const readme = `MZForge server: ${rec.display_name}
Minecraft ${rec.mc_version} (${loaderName})

Address to share with friends (works right now):
    ${rec.hostname}

HOW TO START IT
1. Double-click MZForgeLauncher.exe and keep its window open.
   On the first run it downloads the official ${loaderName} server file
   (from ${jar.source_name}) and, if this PC doesn't have it, ${jar.java}.
   Nothing else to install.
   When it prints SERVER ONLINE, friends can join.

If it can't download the server file (no internet, or a firewall blocks
it), you can put one in this folder by hand and start the launcher again:
   ${getJar}

Your server only exists while MZForgeLauncher.exe is running on this PC.
Closing the window (or shutting down / sleeping the PC) takes it offline.

IF SOMETHING GOES WRONG
The launcher automatically creates MZForge-Debug.log in this folder for the
current run and MZForge-Debug-History.log for earlier runs. They include the
launcher, Minecraft/Paper and Minekube Connect errors. MZForge secrets are
redacted automatically. Send MZForge-Debug.log when asking for support.

STAYING ACTIVE
Your address is held for 30 days at a time. It renews by itself whenever
this server runs. If it goes unused for 30 days it's removed and the name is
freed. To renew by hand, double-click Renew-Server.url (or use the manage
link below) and click Renew.
${modsNote}
Reserved for later: ${rec.custom_hostname}
That branded address isn't live yet. Minekube (the free tunnel network
MZForge uses) needs a manual step on their side per server, and we're
working with them on automating it. Keep using the address above.

MANAGE THIS SERVER (rename, download again, delete, check status):
    ${manageURL}
There are no MZForge accounts: this link is the key to your server.
Anyone who has it can delete the server, so don't share it. Share the
join address instead.

Keep mzforge.properties and Renew-Server.url private too: one holds this
server's secret token, the other is its manage link.

SERVER SETTINGS
Description (MOTD), max players, PvP, game mode and difficulty are set on
your server page. The launcher applies them each time it starts.
`.replace(/\r?\n/g, "\r\n");
  // Windows internet shortcut: double-click opens the server's manage page.
  const renewShortcut = `[InternetShortcut]\r\nURL=${manageURL}\r\n`;
  const extra = {};
  const wl = await playerFileEntries(rec, "whitelist_players");
  const ops = await playerFileEntries(rec, "ops");
  if (rec.connect_token) extra["connect.json"] = JSON.stringify({ token: rec.connect_token }, null, 2);
  if (wl.length) extra["whitelist.json"] = JSON.stringify(wl, null, 2);
  if (ops.length) extra["ops.json"] = JSON.stringify(ops, null, 2);
  return {
    icon_png: rec.icon || "", // empty = the website adds the default MZForge icon
    filename: `mzforge-${rec.slug}.zip`,
    files: {
      "mzforge.properties": properties,
      "eula.txt": "eula=true\n",
      "server.properties": serverPropertiesFile(rec),
      "README.txt": readme,
      "Renew-Server.url": renewShortcut,
      ...extra,
    },
    mods_folder: folder,
    mods: mods.map(({ title, filename, url, sha512 }) => ({ title, filename, url, sha512 })),
  };
}

function webBase(env, url) {
  return (env.PUBLIC_WEB_URL || url.origin).replace(/\/+$/, "");
}

// ---------------------------------------------------------------- handlers

// Validates settings from a request and resolves player names, for both
// create and edit. Returns column -> value updates.
async function settingsUpdates(env, req, rec) {
  const [updates, e] = parseSettings(req);
  if (e) throw new UserError(e);
  const online = "online_mode" in updates ? !!updates.online_mode : rec ? !!rec.online_mode : true;
  const switchedToOnline = rec && !rec.online_mode && online;
  for (const f of ["whitelist_players", "ops"]) {
    const names = f in updates ? updates[f] : switchedToOnline ? parseList(rec[f]).map((p) => p.name) : null;
    if (names) updates[f] = JSON.stringify(await resolvePlayers(env, names, online, rec ? parseList(rec[f]) : []));
  }
  return updates;
}

async function applyUpdates(env, id, updates) {
  const cols = Object.keys(updates); // keys come only from parseSettings / fixed names
  if (!cols.length) return;
  await env.DB.prepare(`UPDATE servers SET ${cols.map((c, i) => `${c} = ?${i + 1}`).join(", ")} WHERE server_id = ?${cols.length + 1}`)
    .bind(...cols.map((c) => updates[c]), id).run();
}

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
  // Optional settings from the create wizard (same fields as editing later).
  // MZForge defaults new servers to Premium + cracked because the platform is
  // intended to accept both. Callers can explicitly send online_mode:true to
  // create a premium-only endpoint.
  if (!("online_mode" in req)) req.online_mode = false;
  const settings = await settingsUpdates(env, req, null);

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
    expires_at: inDays(RENEW_DAYS),
    max_players: 20, pvp: 1, gamemode: "survival", difficulty: "easy", motd: "", mods: "[]",
    view_distance: 10, simulation_distance: 10, connect_token: "", connector: loader === "paper" ? "plugin" : "gate",
    ram_mb: 4096, port: 25565, whitelist: 0, whitelist_players: "[]", ops: "[]", online_mode: 0, icon: "",
  };

  // Insert first: the UNIQUE(slug) constraint settles races between two
  // simultaneous requests for the same name.
  try {
    await env.DB.prepare(
      `INSERT INTO servers (server_id, server_token, manage_key_hash, slug, display_name, hostname, custom_hostname,
         connect_endpoint, loader, mc_version, eula_accepted_at, created_at, expires_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`
    ).bind(rec.server_id, rec.server_token, rec.manage_key_hash, rec.slug, rec.display_name, rec.hostname,
      rec.custom_hostname, rec.connect_endpoint, rec.loader, rec.mc_version, rec.eula_accepted_at, rec.created_at,
      rec.expires_at).run();
  } catch (e) {
    if (/UNIQUE/i.test(String(e))) return err(409, `"${slug}" is already in use, pick another name`);
    throw e;
  }

  await applyUpdates(env, serverId, settings);
  Object.assign(rec, settings);

  // Reserve the branded CNAME (not live until Minekube supports custom domains via API).
  try {
    const recordId = await cfCreateCNAME(env, rec.custom_hostname, rec.hostname, `MZForge server ${serverId}`);
    await env.DB.prepare(`UPDATE servers SET cf_record_id = ?1 WHERE server_id = ?2`).bind(recordId, serverId).run();
  } catch (e) {
    console.log(`cloudflare error for ${slug}: ${e.message}`);
    await env.DB.prepare(`DELETE FROM servers WHERE server_id = ?1`).bind(serverId).run();
    return err(502, "could not create the DNS record — try again in a moment");
  }

  const jar = await jarSource(env, loader, mcVersion);
  const manageURL = `${webBase(env, url)}/#/manage/${serverId}/${manageKey}`;
  return json({
    server_id: serverId,
    hostname: rec.hostname,
    custom_hostname: rec.custom_hostname,
    connect_endpoint: rec.connect_endpoint,
    manage_key: manageKey, // only ever returned here
    download: await downloadFiles(rec, url.origin, jar, manageURL, webBase(env, url)),
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

async function handleServer(request, env, url, id, sub, modId) {
  const [rec, key, fail] = await managed(request, env, id);
  if (fail) return fail;

  if (sub === "renew" && request.method === "POST") {
    rec.expires_at = inDays(RENEW_DAYS);
    await env.DB.prepare(`UPDATE servers SET expires_at = ?1 WHERE server_id = ?2`).bind(rec.expires_at, id).run();
    return json(await view(env, rec, true));
  }
  if (sub === "mods") return handleMods(request, env, rec, modId);
  if (sub === "icon" && !modId) {
    if (request.method === "PUT") {
      let req;
      try { req = await readJSON(request); } catch { return err(400, "invalid JSON body"); }
      if (!validIcon(req?.png)) return err(400, "the icon must be a 64x64 PNG");
      await env.DB.prepare(`UPDATE servers SET icon = ?1 WHERE server_id = ?2`).bind(req.png, id).run();
      rec.icon = req.png;
      return json(await view(env, rec, true));
    }
    if (request.method === "DELETE") {
      await env.DB.prepare(`UPDATE servers SET icon = '' WHERE server_id = ?1`).bind(id).run();
      rec.icon = "";
      return json(await view(env, rec, true));
    }
    return err(405, "method not allowed");
  }
  if (modId) return err(404, "not found");

  if (sub === "files" && request.method === "POST") {
    if (!(await allow(env, `download:${id}`, 30, 3600))) return err(429, "too many downloads — try again later");
    const jar = await jarSource(env, rec.loader, rec.mc_version);
    const manageURL = `${webBase(env, url)}/#/manage/${rec.server_id}/${key}`;
    return json({ server_id: rec.server_id, download: await downloadFiles(rec, url.origin, jar, manageURL, webBase(env, url)) });
  }
  if (sub) return err(404, "not found");

  if (request.method === "GET") return json(await view(env, rec, true));

  if (request.method === "PATCH") {
    let req;
    try { req = await readJSON(request); } catch { return err(400, "invalid JSON body"); }
    if (!req || typeof req !== "object") return err(400, "invalid JSON body");
    const updates = await settingsUpdates(env, req, rec);
    if ("name" in req) {
      const [name, ne] = cleanName(req.name);
      if (ne) return err(400, ne);
      updates.display_name = name;
    }
    if (!Object.keys(updates).length) return err(400, "nothing to change");
    await applyUpdates(env, id, updates);
    Object.assign(rec, updates);
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
  // A server that's actually running is in use: restart its 30 days
  // (unless it already expired: then only Renew brings it back).
  await env.DB.prepare(
    `UPDATE servers SET status = ?1, last_seen = ?2,
       verified_version = CASE WHEN ?3 != '' THEN ?3 ELSE verified_version END,
       checked_at = 0, live_status = '', probe_fails = 0,
       expires_at = CASE WHEN ?1 = 'online' AND expires_at > ?2 AND expires_at < ?5 THEN ?5 ELSE expires_at END
     WHERE server_id = ?4`
  ).bind(req.status, now(), String(req.verified_version || ""), rec.server_id, inDays(RENEW_DAYS)).run();
  return new Response(null, { status: 204 });
}

// The launcher calls this on startup (new launchers only). 403 = expired but
// renewable, 404 = gone. Otherwise it returns what the launcher should apply:
// the website's server.properties values and the mod list.
async function handleLauncherCheck(request, env, url) {
  let req;
  try { req = await readJSON(request); } catch { return err(400, "invalid JSON body"); }
  const [rec, fail] = await launcherAuth(request, env, req?.server_id);
  if (fail) return fail.status === 404 ? err(404, "this server no longer exists: it was deleted, or expired and was removed") : fail;
  if (isExpired(rec)) return json({ error: "expired", expired: true, expires_at: rec.expires_at }, 403);
  return json({
    expires_at: rec.expires_at,
    days_left: daysLeft(rec),
    properties: managedProperties(rec),
    mods_folder: modsFolder(rec.loader),
    mods: parseMods(rec).map(({ title, filename, url, sha512 }) => ({ title, filename, url, sha512 })),
    website: webBase(env, url),
    ram: `${rec.ram_mb || 4096}M`,
    online_mode: !!rec.online_mode,   // account policy; Connect plugin handles cracked opt-in on Paper
    connect_token: rec.connect_token || "",
    connector: effectiveConnector(rec),
    port: rec.port || 25565,
    icon_png: rec.icon || "",
    whitelist: await playerFileEntries(rec, "whitelist_players"),
    ops: await playerFileEntries(rec, "ops"),
    // Everything needed for a first run on a PC with nothing installed:
    server_jar: await resolveJar(env, rec.loader, rec.mc_version),
    java: { major: javaMajor(rec.mc_version), url: javaDownload(env, javaMajor(rec.mc_version)) },
  });
}

// The Connect plugin/Gate writes its own endpoint token on first run. The
// launcher sends it here so future downloads of the same server reconnect
// to the same tunnel identity without the user doing anything.
async function handleConnectToken(request, env) {
  let req;
  try { req = await readJSON(request); } catch { return err(400, "invalid JSON body"); }
  const [rec, fail] = await launcherAuth(request, env, req?.server_id);
  if (fail) return fail;
  const token = String(req?.connect_token || "").trim();
  if (!/^[\w.\-]{8,300}$/.test(token)) return err(400, "that doesn't look like a Connect token");
  if (req.connect_endpoint && req.connect_endpoint !== rec.connect_endpoint) {
    return err(400, "that token belongs to a different endpoint");
  }
  if (rec.connect_token === token) return new Response(null, { status: 204 });
  await env.DB.prepare(`UPDATE servers SET connect_token = ?1 WHERE server_id = ?2`).bind(token, rec.server_id).run();
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

async function handleJarSource(env, url) {
  const loader = url.searchParams.get("loader") || "";
  const version = url.searchParams.get("version") || "";
  if (!LOADERS.has(loader) || !VERSION_RE.test(version)) return err(400, "unknown loader or version");
  return json(await jarSource(env, loader, version));
}

function handleEula(env) {
  const out = { url: "https://aka.ms/MinecraftEULA" };
  if (env.EULA_TEXT) out.text = env.EULA_TEXT;
  return json(out, 200, { "Cache-Control": "public, max-age=3600" });
}

// Public: the server's icon (custom, or the MZForge default). Used by the
// status page and dashboard. Contains nothing secret.
async function handleIconPNG(request, env, url, id) {
  const rec = await env.DB.prepare(`SELECT icon FROM servers WHERE server_id = ?1`).bind(id).first();
  if (rec?.icon) {
    const bin = Uint8Array.from(atob(rec.icon), (c) => c.charCodeAt(0));
    return new Response(bin, { headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=300", ...CORS } });
  }
  return Response.redirect(new URL("/default-icon.png", url).toString(), 302);
}

// Checks a username exists (official accounts) so the website can flag
// typos in whitelist/admin lists straight away.
async function handlePlayerLookup(request, env, url) {
  if (!(await allow(env, `player:${clientIP(request)}`, 60, 60))) return err(429, "slow down");
  const name = String(url.searchParams.get("name") || "").trim();
  if (!MC_NAME.test(name)) return json({ found: false, reason: "not a valid Minecraft username" });
  try {
    const p = await mojangPlayer(env, name);
    return p ? json({ found: true, name: p.name }) : json({ found: false, reason: "no Minecraft account with that name" });
  } catch {
    return err(502, "couldn't reach Mojang to check that name — try again");
  }
}

// ---------------------------------------------------------------- daily cleanup

// Removes servers whose 30 days ran out: deletes the reserved DNS record and
// the row, which frees the name for anyone. A server whose DNS cleanup fails
// is left for the next run rather than leaving an orphaned record.
async function purgeExpired(env) {
  await ensureSchema(env.DB);
  const cutoff = now();
  const { results } = await env.DB.prepare(
    `SELECT server_id, slug, cf_record_id FROM servers WHERE expires_at != '' AND expires_at <= ?1 LIMIT 200`
  ).bind(cutoff).all();
  let removed = 0;
  for (const r of results) {
    try {
      await cfDeleteRecord(env, r.cf_record_id);
    } catch (e) {
      console.log(`purge ${r.server_id}: DNS delete failed, retrying tomorrow: ${e.message}`);
      continue;
    }
    // "AND expires_at <= cutoff" so a Renew that lands mid-purge wins.
    const res = await env.DB.prepare(`DELETE FROM servers WHERE server_id = ?1 AND expires_at <= ?2`).bind(r.server_id, cutoff).run();
    removed += res.meta?.changes || 0;
  }
  console.log(`purge: ${removed} expired server(s) removed`);
  return removed;
}

// ---------------------------------------------------------------- router

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(purgeExpired(env));
  },

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
      if (p === "/meta/server-jar" && m === "GET") return await handleJarSource(env, url);
      if (p === "/meta/eula" && m === "GET") return handleEula(env);
      if (p === "/meta/mode" && m === "GET") return json({ test_mode: testMode(env) });
      if (p === "/modfile" && m === "GET") return await handleModFile(request, env, url);
      if (p === "/launcher/check" && m === "POST") return await handleLauncherCheck(request, env, url);
      if (p === "/launcher/connect-token" && m === "POST") return await handleConnectToken(request, env);

      const im = p.match(/^\/servers\/([a-f0-9]{16})\/icon\.png$/);
      if (im && m === "GET") return await handleIconPNG(request, env, url, im[1]);
      if (p === "/meta/player" && m === "GET") return await handlePlayerLookup(request, env, url);

      const sm = p.match(/^\/servers\/([a-f0-9]{16})(?:\/(files|renew|mods|icon)(?:\/([A-Za-z0-9]{1,16}))?)?$/);
      if (sm) return await handleServer(request, env, url, sm[1], sm[2], sm[3]);

      // Anything else: the website (index.html, MZForgeLauncher.exe, ...).
      if (env.ASSETS) return env.ASSETS.fetch(request);
      return err(404, "not found");
    } catch (e) {
      if (e instanceof UserError) return err(400, e.message);
      if (/Mojang HTTP/.test(String(e?.message))) return err(502, "couldn't reach Mojang to check player names — try again in a moment");
      console.log(`unhandled error on ${m} ${p}: ${e.stack || e}`);
      return err(500, "something went wrong on our side — try again in a moment");
    }
  },
};
