"""gpx-stitch MCP server: combine other people's GPX tracks into one continuous course."""
from __future__ import annotations

import asyncio
import functools
import os
import re
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import httpx
from mcp.server.mcpserver import MCPServer
from mcp.server.mcpserver.exceptions import ToolError

from .geo import FT_PER_M, Track, clip, resample, stats, stitch
from .remote import Elevation, Router, fetch_gpx
from .store import TrackStore, parse_gpx, slugify, to_gpx

INSTRUCTIONS = """\
Builds one continuous GPX course out of several existing tracks (yours or other people's).
Typical flow:
1. load_track for each piece (URL, a file path in the inbox folder, or raw GPX text).
2. Optionally clip_track to keep only the stretch you need (give lat/lon near the cut points).
3. stitch_tracks in travel order. Pieces are flipped and overlaps trimmed automatically;
   gaps are snapped, bridged with a straight line, or routed on trails.
4. elevate_track to replace noisy GPS elevation with USGS 3DEP DEM values.
5. export_gpx, then pass the returned path to the Garmin MCP's upload_course.
All distances are miles and all elevations are feet. Check each join's gap_ft and bridge type,
and tell the user about any straight-line bridge longer than a few hundred feet.
"""


@dataclass
class Config:
    data_dir: Path
    inbox_dir: Path
    export_dir: Path

    @classmethod
    def from_env(cls) -> "Config":
        return cls(Path(os.environ.get("GPX_DATA_DIR", "/data")),
                   Path(os.environ.get("GPX_INBOX_DIR", "/srv/gpx/inbox")),
                   Path(os.environ.get("GPX_EXPORT_DIR", "/srv/gpx/out")))


def _safe_path(p: str, roots: list[Path]) -> Path:
    path = Path(p).expanduser().resolve()
    for r in roots:
        if path.is_relative_to(r.resolve()):
            return path
    raise ValueError(f"path must be inside one of: {', '.join(str(r) for r in roots)}")


def build_server(cfg: Config, store: TrackStore, elevation: Elevation, router: Router) -> MCPServer:
    for d in (cfg.inbox_dir, cfg.export_dir):
        d.mkdir(parents=True, exist_ok=True)
    server = MCPServer("gpx-stitch", instructions=INSTRUCTIONS, version="0.1.0")

    class _Tools:
        """Registers tools; expected failures become ToolError so the message reaches the model."""
        custom_route = staticmethod(server.custom_route)

        @staticmethod
        def tool():
            def deco(fn):
                @functools.wraps(fn)
                async def wrapper(*args, **kwargs):
                    try:
                        return await fn(*args, **kwargs)
                    except (ValueError, RuntimeError, OSError) as exc:
                        raise ToolError(str(exc)) from exc
                    except httpx.HTTPError as exc:
                        raise ToolError(f"network error: {exc}") from exc
                return server.tool()(wrapper)
            return deco

    mcp = _Tools()

    def summary(tid: str, t: Track) -> dict:
        return {"track_id": tid, "name": t.name, **stats(t)}

    @mcp.custom_route("/healthz", methods=["GET"])
    async def healthz(request):
        from starlette.responses import JSONResponse
        return JSONResponse({"ok": True, "tracks": len(store.items()), "routing": router.available})

    @mcp.tool()
    async def load_track(source: str | None = None, gpx_text: str | None = None,
                         name: str | None = None) -> dict:
        """Load a GPX track. `source` is an http(s) URL or a file path inside the inbox folder;
        alternatively pass the raw GPX in `gpx_text`. Returns a track_id plus mi/ft stats."""
        if bool(source) == bool(gpx_text):
            raise ValueError("pass exactly one of source or gpx_text")
        if gpx_text:
            text, origin = gpx_text, "inline"
        elif source.startswith(("http://", "https://")):
            text, origin = await fetch_gpx(source), source
        else:
            path = _safe_path(source, [cfg.inbox_dir, cfg.export_dir])
            text, origin = path.read_text(errors="replace"), str(path)
        t = parse_gpx(text, name)
        t.notes.append(f"loaded from {origin}")
        tid = store.add(t)
        return summary(tid, t)

    @mcp.tool()
    async def list_inbox() -> dict:
        """List GPX files waiting in the inbox folder (drop manual downloads there)."""
        files = sorted(p for p in cfg.inbox_dir.rglob("*") if p.suffix.lower() == ".gpx")
        return {"inbox": str(cfg.inbox_dir), "files": [str(p) for p in files]}

    @mcp.tool()
    async def list_tracks() -> dict:
        """List loaded tracks with distance (mi) and gain (ft)."""
        rows = []
        for tid, t in store.items():
            s = stats(t)
            rows.append({"track_id": tid, "name": t.name, "distance_mi": s["distance_mi"],
                         "gain_ft": s["gain_ft"], "elevation_source": t.ele_source})
        return {"tracks": rows}

    @mcp.tool()
    async def track_info(track_id: str) -> dict:
        """Full stats for one track: mi, gain/loss ft, min/max elevation ft, endpoints, history."""
        t = store.get(track_id)
        return {**summary(track_id, t), "history": t.notes}

    @mcp.tool()
    async def clip_track(track_id: str, start_lat: float | None = None, start_lon: float | None = None,
                         end_lat: float | None = None, end_lon: float | None = None,
                         name: str | None = None) -> dict:
        """Keep only the part of a track between two points (each snaps to the nearest track point).
        Omit start or end to keep from the track's beginning or to its end. If end comes before
        start along the track, the result runs in reverse. Creates a new track."""
        t = store.get(track_id)
        start = (start_lat, start_lon) if start_lat is not None and start_lon is not None else None
        end = (end_lat, end_lon) if end_lat is not None and end_lon is not None else None
        if not start and not end:
            raise ValueError("give a start point, an end point, or both")
        out, info = clip(t, start, end)
        out.name = name or f"{t.name} (clip)"
        out.notes = t.notes + [f"clipped from {track_id}"]
        if max(info["start_snap_ft"], info["end_snap_ft"]) > 500:
            info["warning"] = "a cut point is more than 500 ft from the track; check the coordinates"
        tid = store.add(out)
        return {**summary(tid, out), "clip": info}

    @mcp.tool()
    async def reverse_track(track_id: str) -> dict:
        """Create a reversed copy of a track."""
        t = store.get(track_id).reversed()
        t.name = f"{t.name} (reversed)"
        t.notes.append(f"reversed from {track_id}")
        tid = store.add(t)
        return summary(tid, t)

    @mcp.tool()
    async def stitch_tracks(track_ids: list[str], name: str, gap_mode: str = "auto",
                            snap_ft: float = 100, straight_max_ft: float = 500) -> dict:
        """Join tracks in travel order into one continuous track.

        Each piece is flipped if needed and overlap at each junction is trimmed. Gaps up to
        snap_ft are joined directly. Bigger gaps: gap_mode "straight" draws a line (use for
        cross-country), "route" routes on trails via OpenRouteService, "auto" routes only gaps
        longer than straight_max_ft. Returns per-join details (gap, trimmed ft, bridge type)."""
        segs = [store.get(i) for i in track_ids]
        if gap_mode != "straight" and not router.available:
            note = "No ORS_API_KEY configured; all gaps will be straight lines."
        else:
            note = None
        out, joins = await asyncio.to_thread(
            stitch, segs, name, gap_mode=gap_mode, snap_m=snap_ft / FT_PER_M,
            straight_max_m=straight_max_ft / FT_PER_M, router=router.route)
        out.notes = [f"stitched from {', '.join(track_ids)}"]
        tid = store.add(out)
        res = {**summary(tid, out), "joins": joins}
        long_straight = [j for j in joins if j.get("bridge") == "straight" and j.get("bridge_ft", 0) > 500]
        if long_straight:
            res["review"] = f"{len(long_straight)} straight-line bridge(s) over 500 ft; confirm they follow passable terrain"
        if note:
            res["note"] = note
        return res

    @mcp.tool()
    async def elevate_track(track_id: str, spacing_ft: float = 100) -> dict:
        """Replace elevation with DEM values (USGS 3DEP ~10 m in the US). The track is resampled to
        evenly spaced points first (spacing_ft), which also removes GPS jitter. Updates in place."""
        t = store.get(track_id)
        before = stats(t)
        if spacing_ft < 30:
            raise ValueError("spacing_ft must be at least 30")
        r = resample(t, spacing_ft / FT_PER_M)
        if len(r) > 6000:
            raise ValueError(f"{len(r)} points at {spacing_ft} ft spacing; raise spacing_ft to stay under 6000")
        ele = await elevation.lookup(r.lat, r.lon)
        if (~np.isnan(ele)).sum() < 2:
            raise ValueError("elevation service returned no data for this area")
        r.ele = ele
        r.ele_source = "dem"
        r.notes = t.notes + [f"DEM elevation ({elevation.provider}), {spacing_ft:g} ft spacing"]
        store.replace(track_id, r)
        return {**summary(track_id, r),
                "gain_ft_before": before["gain_ft"] if before["elevation_source"] != "none" else None}

    @mcp.tool()
    async def export_gpx(track_id: str, filename: str | None = None, include_text: bool = False) -> dict:
        """Write the track as a GPX file to the export folder (shared with the Garmin MCP).
        Pass the returned `path` to Garmin's upload_course. Set include_text to also get the XML."""
        t = store.get(track_id)
        fname = slugify(re.sub(r"\.gpx$", "", filename or t.name, flags=re.I)) + ".gpx"
        path = cfg.export_dir / fname
        s = stats(t)
        desc = f"{s['distance_mi']} mi, {s['gain_ft']} ft gain (elevation: {t.ele_source}). Built with gpx-stitch."
        path.write_text(to_gpx(t, desc))
        res = {"path": str(path), **summary(track_id, t)}
        if include_text:
            res["gpx_text"] = path.read_text()
        return res

    @mcp.tool()
    async def delete_track(track_id: str) -> dict:
        """Remove a track from the working set."""
        store.delete(track_id)
        return {"deleted": track_id}

    return server


def main() -> None:
    """Run over stdio (`gpx-stitch --stdio`, e.g. behind an OAuth proxy) or streamable HTTP (default)."""
    import sys

    cfg = Config.from_env()
    store = TrackStore(cfg.data_dir)
    elevation = Elevation(provider=os.environ.get("ELEVATION_PROVIDER", "opentopodata"),
                          base_url=os.environ.get("OPENTOPODATA_URL", "https://api.opentopodata.org"),
                          dataset=os.environ.get("OPENTOPODATA_DATASET", "ned10m"),
                          min_interval_s=float(os.environ.get("OPENTOPODATA_MIN_INTERVAL", "1.05")))
    router = Router(os.environ.get("ORS_API_KEY") or None)
    mcp = build_server(cfg, store, elevation, router)

    if "--stdio" in sys.argv[1:] or os.environ.get("MCP_TRANSPORT") == "stdio":
        mcp.run("stdio")
        return

    import uvicorn
    from mcp.server.transport_security import TransportSecuritySettings
    from starlette.middleware.base import BaseHTTPMiddleware
    from starlette.responses import JSONResponse

    allowed = [h.strip() for h in os.environ.get("MCP_ALLOWED_HOSTS", "").split(",") if h.strip()]
    security = TransportSecuritySettings(enable_dns_rebinding_protection=bool(allowed),
                                         allowed_hosts=allowed, allowed_origins=[])
    app = mcp.streamable_http_app(host=os.environ.get("MCP_HOST", "0.0.0.0"), transport_security=security)

    token = os.environ.get("MCP_AUTH_TOKEN")
    if token:
        class Bearer(BaseHTTPMiddleware):
            async def dispatch(self, request, call_next):
                ok = (request.headers.get("authorization") == f"Bearer {token}"
                      or request.query_params.get("key") == token)  # for clients that can't set headers
                if request.url.path != "/healthz" and not ok:
                    return JSONResponse({"error": "unauthorized"}, status_code=401)
                return await call_next(request)
        app.add_middleware(Bearer)

    uvicorn.run(app, host=os.environ.get("MCP_HOST", "0.0.0.0"), port=int(os.environ.get("MCP_PORT", "8790")))


if __name__ == "__main__":
    main()
