# Feed Augmenter

Proxies remote JSON feeds (e.g. Streamworks `/vmix/*.json`), adds custom fields, and
serves the result on the local network for vMix data sources and GT titles.

## Run

Requires **Node.js 18+** (no `npm install` needed).

- **Windows:** double-click `start.bat`
- **macOS/Linux:** `./start.command` (or `node server.js`)

Dashboard: <http://localhost:47820/>. The console also prints the LAN addresses.

## Use in vMix

Each feed is served at:

```
http://<this-computer>:47820/feed/<slug>        augmented
http://<this-computer>:47820/feed/<slug>/raw    source, unchanged (normalised to an array)
```

In vMix, add the URL as a **Data Source → JSON**. If vMix runs on another
machine, use the LAN address and allow Node through Windows Firewall when asked.

## Rules

Rules run top to bottom on every row. Later rules can use fields created by earlier ones.

| Rule | Does |
|---|---|
| Static field | Adds a fixed value |
| Template field | Builds text, e.g. `{next_time} GST · {track}`. `{field\|fallback}` uses the fallback when empty |
| Conditional field | `If state equals live → LIVE NOW, otherwise → {starts_in}` |
| Override source field | Replaces a source field (templates allowed) |
| Rename source field | Moves a source field to a new name |
| Remove source field | Deletes a source field |

**Tidy separators** removes leftover `·`, `|`, `-` and extra spaces when a placeholder is empty.

**Output shape** (per feed): *Flat* puts added fields at the top level of each row;
*Nested* puts them under a key (default `custom`). Rename/override/remove always act on the top level.

## Behaviour

- Responses are cached for *Cache (seconds)* per feed, so several vMix inputs polling
  the same feed only cause one request to the remote server.
- If the remote fails, the last good data keeps being served (header `X-Feed-Stale: 1`)
  and the feed's dot in the dashboard turns red.

## Config

Everything is saved to `config.json` next to `server.js`. It's created on first run
and is not committed to git (feed URLs can contain access tokens). To move a setup to
another computer, copy `config.json` across.

Environment overrides: `PORT`, `HOST` (default `0.0.0.0`), `CONFIG_PATH`.
Change the port with `"port"` in `config.json` (restart to apply).
