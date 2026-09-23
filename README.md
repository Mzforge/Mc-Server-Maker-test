# MZForge

Free Minecraft Java servers that run on the player's own PC.
Runs on Cloudflare Workers (free). No VPS, no PC to keep on.

## Setup

1. Upload all these files to your GitHub repo (Add file → Upload files).
2. Cloudflare dashboard → Workers & Pages → Create → Import a repository →
   pick the repo → Deploy.
3. Open the link Cloudflare gives you. That's your site.

Every change you commit to GitHub goes live automatically.

## Files

| File | What it is |
|---|---|
| index.html | the website |
| logo-64.png, logo-480.webp | the MZForge logo (header, favicon, home page) |
| default-icon.png | the in-game server icon for servers without their own |
| MZForgeLauncher.exe | the launcher people download |
| index.js, mcping.js | the API |
| wrangler.toml | Cloudflare settings |
| .assetsignore | keeps everything except the website files private |
| _headers | security settings for the website |
| package.json, package-lock.json | tells Cloudflare which tools to use |

## Features

- **30-day addresses.** Each server's address is held 30 days at a time.
  Running the server or clicking *Renew server (30 days)* restarts the
  count. A daily job (03:17 UTC, set in wrangler.toml) removes servers
  that ran out and frees their names. The page warns in the last 7 days.
- **Renew-Server.url** in every download opens the server's manage page.
  The launcher checks in on start: if the server expired it opens that
  page instead of starting; if it was removed it says so.
- **Mods & plugins** tab: searches Modrinth, filtered to the server's
  loader (Fabric mods / Paper plugins) and Minecraft version, and adds
  required dependencies automatically. Chosen files are included in
  downloads (checked against Modrinth's SHA-512), and the launcher
  downloads newly added ones on start. It never deletes files.
- **Create wizard** (Server type, Basics, Appearance, Plugins/Mods,
  Create) with a live Minecraft-server-list preview. The same options are
  on each server's Settings and Mods tabs afterwards.
- **Settings:** RAM (with a recommendation from software, players and
  add-ons), max players, game mode, difficulty, PvP, whitelist, official or
  cracked accounts, admins (op), local port, icon and MOTD. Written into the
  download and re-applied by the launcher on every start. Whitelist/admin
  names are checked against Mojang; in-game additions are kept.
- **Nothing to install by hand.** On its first run the launcher downloads
  the official server file for the chosen loader and version (Mojang,
  PaperMC or FabricMC, resolved by the Worker and checksum-verified) and,
  if the PC lacks the right Java, a private Temurin runtime into a
  `runtime` folder. Downloads are restricted to those vendors' own hosts.
- **Appearance:** server name and an optional second line, each with a
  Minecraft colour, shown live in a server-list preview. Stored as one
  motd with colour codes and a newline.
- **Icons:** any uploaded picture becomes a 64x64 server-icon.png. Servers
  without one get the MZForge logo (default-icon.png).
- **Popular picks** per loader with "Recommended" badges. Geyser and voice
  chat are deliberately left out: they need UDP ports Minekube's tunnel
  doesn't carry.

The database upgrades itself: servers created before this version get the
new settings with defaults and a fresh 30 days.

## Later (optional)

- **Use mzforge.com:** Worker → Settings → Domains & Routes → Add →
  Custom domain. Then add `PUBLIC_WEB_URL = "https://mzforge.com"` under
  `[vars]` in wrangler.toml.
- **Reserve name.mc.mzforge.com addresses:** Worker → Settings → Variables
  and Secrets → add a Secret `CF_API_TOKEN` (a Cloudflare token with
  "Edit zone DNS" for mzforge.com), and add `CF_ZONE_ID = "your zone id"`
  under `[vars]` in wrangler.toml.
- **Status looks wrong after launch?** Add `LIVE_PING = "false"` under
  `[vars]`.
- **Deploy error about "database_id"?** Storage & Databases → D1 → Create,
  name it `mzforge`, copy its ID, and add `database_id = "the-id"` under
  `database_name = "mzforge"` in wrangler.toml.
