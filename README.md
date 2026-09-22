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
| MZForgeLauncher.exe | the launcher people download |
| index.js, mcping.js | the API |
| wrangler.toml | Cloudflare settings |
| .assetsignore | keeps everything except the website files private |
| _headers | security settings for the website |
| package.json, package-lock.json | tells Cloudflare which tools to use |

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
