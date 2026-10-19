"""GPX parsing/writing and a small persistent track store."""
from __future__ import annotations

import json
import re
import threading
from pathlib import Path

import gpxpy
import gpxpy.gpx
import numpy as np

from .geo import Track


def parse_gpx(text: str, name: str | None = None) -> Track:
    g = gpxpy.parse(text)
    lat, lon, ele = [], [], []
    for trk in g.tracks:
        for seg in trk.segments:
            for p in seg.points:
                lat.append(p.latitude); lon.append(p.longitude)
                ele.append(np.nan if p.elevation is None else p.elevation)
    if not lat:  # route-only files (CalTopo/Gaia exports sometimes)
        for rte in g.routes:
            for p in rte.points:
                lat.append(p.latitude); lon.append(p.longitude)
                ele.append(np.nan if p.elevation is None else p.elevation)
    if len(lat) < 2:
        raise ValueError("GPX has fewer than 2 track/route points (waypoint-only files aren't supported)")
    if not name:
        name = (g.tracks[0].name if g.tracks and g.tracks[0].name else None) or \
               (g.routes[0].name if g.routes and g.routes[0].name else None) or g.name or "track"
    return Track(name, np.array(lat), np.array(lon), np.array(ele), "gps")


def to_gpx(t: Track, description: str | None = None) -> str:
    g = gpxpy.gpx.GPX()
    g.creator = "gpx-stitch"
    trk = gpxpy.gpx.GPXTrack(name=t.name, description=description)
    seg = gpxpy.gpx.GPXTrackSegment()
    for la, lo, e in zip(t.lat, t.lon, t.ele):
        seg.points.append(gpxpy.gpx.GPXTrackPoint(
            round(float(la), 7), round(float(lo), 7), elevation=None if np.isnan(e) else round(float(e), 1)))
    trk.segments.append(seg)
    g.tracks.append(trk)
    return g.to_xml()


def slugify(s: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")
    return s[:40] or "track"


class TrackStore:
    """In-memory tracks, persisted as GPX + metadata so they survive restarts."""

    def __init__(self, data_dir: Path):
        self.dir = Path(data_dir) / "tracks"
        self.dir.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._tracks: dict[str, Track] = {}
        self._seq = 0
        for meta in sorted(self.dir.glob("*.json")):
            try:
                m = json.loads(meta.read_text())
                t = parse_gpx((self.dir / f"{meta.stem}.gpx").read_text(), m["name"])
                t.ele_source = m.get("ele_source", t.ele_source)
                t.notes = m.get("notes", [])
                self._tracks[meta.stem] = t
                n = int(meta.stem.split("-", 1)[0][1:])
                self._seq = max(self._seq, n)
            except Exception:
                continue

    def add(self, t: Track) -> str:
        with self._lock:
            self._seq += 1
            tid = f"t{self._seq}-{slugify(t.name)}"
            self._tracks[tid] = t
            (self.dir / f"{tid}.gpx").write_text(to_gpx(t))
            (self.dir / f"{tid}.json").write_text(json.dumps(
                {"name": t.name, "ele_source": t.ele_source, "notes": t.notes}))
            return tid

    def replace(self, tid: str, t: Track) -> None:
        with self._lock:
            self.get(tid)
            self._tracks[tid] = t
            (self.dir / f"{tid}.gpx").write_text(to_gpx(t))
            (self.dir / f"{tid}.json").write_text(json.dumps(
                {"name": t.name, "ele_source": t.ele_source, "notes": t.notes}))

    def get(self, tid: str) -> Track:
        try:
            return self._tracks[tid]
        except KeyError:
            raise ValueError(f"unknown track_id '{tid}'; call list_tracks") from None

    def delete(self, tid: str) -> None:
        with self._lock:
            self.get(tid)
            del self._tracks[tid]
            for ext in ("gpx", "json"):
                (self.dir / f"{tid}.{ext}").unlink(missing_ok=True)

    def items(self):
        return list(self._tracks.items())
