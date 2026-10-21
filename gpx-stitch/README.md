# gpx-stitch

An MCP server that builds one continuous GPX course out of existing tracks: yours, Peakbagger
ascents, CalTopo or Gaia exports, anything with a track line. All output is in **miles and feet**.

## What it does

| Tool | Purpose |
|---|---|
| `load_track` | Load from a URL, a file in the inbox folder, or raw GPX text |
| `list_inbox` | Show GPX files dropped into the inbox (for downloads that need a login) |
| `list_tracks` / `track_info` | Distance (mi), gain/loss (ft), min/max elevation (ft), endpoints |
| `clip_track` | Keep only the stretch between two lat/lon points (snaps to the track) |
| `reverse_track` | Flip direction |
| `stitch_tracks` | Join tracks in travel order: auto-flips pieces, trims overlap, bridges gaps |
| `elevate_track` | Resample and replace GPS elevation with USGS 3DEP (~10 m DEM) |
| `export_gpx` | Write the course to the shared folder; pass `path` to Garmin's `upload_course` |
| `delete_track` | Remove a working track |

### How stitching works

For each pair of pieces, the junction is the **closest pair of points** between the end half
of the route built so far and the start half of the next piece. Anything past the junction on
either side (overshoot, a shared stretch) is trimmed, and the next piece is flipped if its
reverse joins better. Then the gap:

- **≤ `snap_ft`** (default 100 ft): joined directly.
- **`gap_mode="straight"`**: straight line. Use for cross-country and Class 3 terrain.
- **`gap_mode="route"`**: routed on OSM trails via OpenRouteService (needs `ORS_API_KEY`).
- **`gap_mode="auto"`** (default): straight up to `straight_max_ft` (500 ft), routed beyond.

Every join reports `gap_ft`, `trimmed_prev_ft`, `trimmed_next_ft`, `flipped` and the bridge
type, so you can check the result before trusting it.

### Why re-elevate

Gain computed from other people's GPS elevation is noisy and usually inflated. `elevate_track`
resamples to even spacing (default 100 ft) and pulls DEM elevation; gain uses a 10 ft
hysteresis threshold. Stats include `elevation_source` (`gps`, `dem`, `mixed`, `none`).

## Running it

**In this repo** it runs as the `gpx-mcp` service: `gpx-server.js` adds the same OAuth layer as
the Garmin/Strava/COROS proxies and spawns `gpx-stitch --stdio`. Setup, env vars and the shared
`/srv/gpx` folder are covered in the [main README](../README.md#gpx-stitch-gpx-course-builder).

**Standalone** (e.g. for Claude Code on your laptop):

```bash
pip install .
gpx-stitch --stdio                                   # stdio transport
MCP_AUTH_TOKEN=secret MCP_PORT=8790 gpx-stitch       # streamable HTTP on :8790/mcp, bearer auth
```

| Variable | Default | Purpose |
|---|---|---|
| `GPX_DATA_DIR` | `/data` | Working tracks (persisted as GPX + JSON) |
| `GPX_INBOX_DIR` | `/srv/gpx/inbox` | Where `load_track` may read local files |
| `GPX_EXPORT_DIR` | `/srv/gpx/out` | Where `export_gpx` writes |
| `ORS_API_KEY` | (none) | Trail routing for gaps |
| `ELEVATION_PROVIDER` | `opentopodata` | or `usgs` |
| `MCP_AUTH_TOKEN` | (none) | HTTP mode only: `Authorization: Bearer` or `?key=` |

## Example session

> Stitch my Garmin "Lamarck Col to Piute Pass" course with the Peakbagger track for Mt Lamarck,
> clip the Peakbagger track at the col, route any trail gaps, elevate, and send it to Garmin.

1. `download_course_gpx` (Garmin MCP), saved into `/srv/gpx/inbox/`
2. `load_track` (Garmin file), `load_track` (Peakbagger URL, or a manual download in the inbox)
3. `clip_track` at the col's lat/lon
4. `stitch_tracks([...], "Lamarck + Piute", gap_mode="auto")`
5. `elevate_track` → `export_gpx` → `upload_course(gpx_path="/srv/gpx/out/lamarck-piute.gpx")`

## Notes and limits

- Each input must contain one non-empty track segment or route. Multiple segments/tracks
  or route-only files with multiple routes are rejected. Split them into separate GPX
  files, load each, and review their joins with `stitch_tracks`.
- URL loading blocks private/loopback/link-local addresses (including the droplet metadata
  service), caps files at 25 MB, and only accepts responses that are actually GPX. Pages that
  need a login (Peakbagger, AllTrails) should be downloaded by hand into `/srv/gpx/inbox`.
- Public OpenTopoData allows ~1 request/s and 1,000 requests/day (100 points each), which is
  roughly 100,000 points a day. For heavier use, self-host OpenTopoData with the NED 10 m
  dataset and point `OPENTOPODATA_URL` at it.
- Order matters: pass tracks to `stitch_tracks` in the order you'll travel them.
- Straight-line bridges over 500 ft are flagged for review: check them against the map.

## Tests

```bash
pip install -e '.[test]' && pytest -q
```

From the repository root, run `npm install && npm test` for OAuth callback, PKCE,
and concurrent JSON-RPC proxy regressions. These use local HTTP listeners and fake
subprocess streams; they do not contact upstream services or read saved tokens.
