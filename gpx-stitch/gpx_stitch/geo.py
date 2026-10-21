"""Track geometry: distance, clipping, orientation, stitching, resampling, stats.

All internal math is metric (meters). Conversion to mi/ft happens only in
`stats()` and in user-facing summaries.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable, Sequence

import numpy as np

EARTH_R_M = 6_371_008.8
M_PER_MI = 1609.344
FT_PER_M = 3.280839895


@dataclass
class Track:
    name: str
    lat: np.ndarray
    lon: np.ndarray
    ele: np.ndarray  # meters; NaN where unknown
    ele_source: str = "gps"  # "gps" | "dem" | "mixed" | "none"
    notes: list[str] = field(default_factory=list)

    def __post_init__(self) -> None:
        self.lat = np.asarray(self.lat, dtype=float)
        self.lon = np.asarray(self.lon, dtype=float)
        if self.ele is None:
            self.ele = np.full(self.lat.shape, np.nan)
        self.ele = np.asarray(self.ele, dtype=float)
        if not (self.lat.shape == self.lon.shape == self.ele.shape):
            raise ValueError("lat/lon/ele length mismatch")
        if np.all(np.isnan(self.ele)):
            self.ele_source = "none"

    def __len__(self) -> int:
        return int(self.lat.size)

    def slice(self, i: int, j: int) -> "Track":
        """Inclusive slice i..j; reversed if i > j."""
        if i <= j:
            s = slice(i, j + 1)
            return Track(self.name, self.lat[s], self.lon[s], self.ele[s], self.ele_source, list(self.notes))
        return self.slice(j, i).reversed()

    def reversed(self) -> "Track":
        return Track(self.name, self.lat[::-1].copy(), self.lon[::-1].copy(), self.ele[::-1].copy(),
                     self.ele_source, list(self.notes))


# ---------------------------------------------------------------- distance

def haversine_m(lat1, lon1, lat2, lon2):
    lat1, lon1, lat2, lon2 = map(np.radians, (lat1, lon1, lat2, lon2))
    a = np.sin((lat2 - lat1) / 2) ** 2 + np.cos(lat1) * np.cos(lat2) * np.sin((lon2 - lon1) / 2) ** 2
    return 2 * EARTH_R_M * np.arcsin(np.sqrt(np.clip(a, 0, 1)))


def cumdist_m(t: Track) -> np.ndarray:
    if len(t) < 2:
        return np.zeros(len(t))
    d = haversine_m(t.lat[:-1], t.lon[:-1], t.lat[1:], t.lon[1:])
    return np.concatenate([[0.0], np.cumsum(d)])


def nearest_index(t: Track, lat: float, lon: float) -> tuple[int, float]:
    d = haversine_m(t.lat, t.lon, lat, lon)
    i = int(np.argmin(d))
    return i, float(d[i])


def closest_pair(a: Track, a_rng: range, b: Track, b_rng: range, chunk: int = 2000) -> tuple[int, int, float]:
    """Closest (i in a_rng, j in b_rng) pair. Chunked brute force; fine for trail-sized tracks."""
    ai = np.arange(a_rng.start, a_rng.stop)
    bj = np.arange(b_rng.start, b_rng.stop)
    best = (int(ai[-1]), int(bj[0]), float("inf"))
    for k in range(0, bj.size, chunk):
        jj = bj[k:k + chunk]
        d = haversine_m(a.lat[ai][:, None], a.lon[ai][:, None], b.lat[jj][None, :], b.lon[jj][None, :])
        flat = int(np.argmin(d))
        r, c = divmod(flat, d.shape[1])
        if d[r, c] < best[2]:
            best = (int(ai[r]), int(jj[c]), float(d[r, c]))
    return best


# ---------------------------------------------------------------- editing

def clip(t: Track, start: tuple[float, float] | None, end: tuple[float, float] | None) -> tuple[Track, dict]:
    i, di = nearest_index(t, *start) if start else (0, 0.0)
    j, dj = nearest_index(t, *end) if end else (len(t) - 1, 0.0)
    if i == j:
        raise ValueError("start and end snap to the same point on the track")
    out = t.slice(i, j)
    return out, {"start_snap_ft": round(di * FT_PER_M), "end_snap_ft": round(dj * FT_PER_M),
                 "reversed": i > j}


def straight_line(lat1, lon1, lat2, lon2, spacing_m: float = 25.0) -> tuple[np.ndarray, np.ndarray]:
    d = float(haversine_m(lat1, lon1, lat2, lon2))
    n = max(2, int(np.ceil(d / spacing_m)) + 1)
    f = np.linspace(0, 1, n)
    return lat1 + (lat2 - lat1) * f, lon1 + (lon2 - lon1) * f


Router = Callable[[float, float, float, float], "tuple[np.ndarray, np.ndarray] | None"]


def _head(t: Track, frac: float) -> range:
    return range(0, max(1, int(np.ceil(len(t) * frac))))


def _tail(t: Track, frac: float, start: int = 0) -> range:
    n = len(t) - start
    return range(start + n - max(1, int(np.ceil(n * frac))), len(t))


def stitch(segments: Sequence[Track], name: str, *, gap_mode: str = "auto", snap_m: float = 30.0,
           straight_max_m: float = 150.0, window: float = 0.5,
           router: Router | None = None) -> tuple[Track, list[dict]]:
    """Join segments in the given order into one continuous track.

    For each consecutive pair the junction is the closest pair of points between
    the tail of what's been built so far and the head of the next segment, so
    overshoot/overlap on either side is trimmed. Each segment is flipped if its
    reversed orientation joins better. Gaps wider than `snap_m` get a bridge:
    straight line, or routed on trails when gap_mode is "route" (or "auto" and the
    gap exceeds `straight_max_m`).
    """
    if len(segments) < 2:
        raise ValueError("need at least two tracks to stitch")
    if gap_mode not in ("auto", "route", "straight"):
        raise ValueError("gap_mode must be auto, route or straight")
    for s in segments:
        if len(s) < 2:
            raise ValueError(f"track '{s.name}' has fewer than 2 points")

    # Orient the first segment against the second.
    a0, b0 = segments[0], segments[1]
    best = None
    for a in (a0, a0.reversed()):
        for b in (b0, b0.reversed()):
            i, j, d = closest_pair(a, _tail(a, window), b, _head(b, window))
            if best is None or d < best[0]:
                best = (d, a)
    acc = best[1]
    last_start = 0
    joins: list[dict] = []
    ele_sources = {segments[0].ele_source}

    for k, seg in enumerate(segments[1:], start=1):
        tail = _tail(acc, window, last_start)
        cands = []
        for b, flipped in ((seg, False), (seg.reversed(), True)):
            i, j, d = closest_pair(acc, tail, b, _head(b, window))
            cands.append((d, i, j, b, flipped))
        d, i, j, b, flipped = min(cands, key=lambda c: c[0])
        ele_sources.add(seg.ele_source)
        cda = cumdist_m(acc)
        info = {"from": segments[k - 1].name, "to": seg.name,
                "flipped": flipped, "gap_ft": round(d * FT_PER_M),
                "trimmed_prev_ft": round(float(cda[-1] - cda[i]) * FT_PER_M),
                "trimmed_next_ft": round(float(cumdist_m(b)[j]) * FT_PER_M)}

        head = acc.slice(0, i)
        rest = b.slice(j, len(b) - 1)
        if d <= snap_m:
            info["bridge"] = "snapped"
            if d < 1.0 and len(rest) > 1:  # duplicate point
                rest = rest.slice(1, len(rest) - 1)
            bl, bo = np.array([]), np.array([])
        else:
            use_route = gap_mode == "route" or (gap_mode == "auto" and d > straight_max_m)
            routed = router(head.lat[-1], head.lon[-1], rest.lat[0], rest.lon[0]) if (use_route and router) else None
            if routed is not None and len(routed[0]) >= 2:
                bl, bo = routed[0][1:-1], routed[1][1:-1]
                info["bridge"] = "routed"
            else:
                bl, bo = straight_line(head.lat[-1], head.lon[-1], rest.lat[0], rest.lon[0])
                bl, bo = bl[1:-1], bo[1:-1]
                info["bridge"] = "straight"
                if use_route:
                    info["note"] = "routing unavailable or failed; used a straight line"
            info["bridge_ft"] = round(
                float(np.sum(haversine_m(np.r_[head.lat[-1], bl], np.r_[head.lon[-1], bo],
                                         np.r_[bl, rest.lat[0]], np.r_[bo, rest.lon[0]]))) * FT_PER_M)
        last_start = len(head) + len(bl)
        acc = Track(name, np.r_[head.lat, bl, rest.lat], np.r_[head.lon, bo, rest.lon],
                    np.r_[head.ele, np.full(len(bl), np.nan), rest.ele])
        joins.append(info)

    acc.name = name
    srcs = ele_sources - {"none"}
    acc.ele_source = "none" if not srcs else (srcs.pop() if len(srcs) == 1 else "mixed")
    if np.all(np.isnan(acc.ele)):
        acc.ele_source = "none"
    return acc, joins


def resample(t: Track, spacing_m: float) -> Track:
    """Evenly spaced points along the track (linear interpolation)."""
    cd = cumdist_m(t)
    total = cd[-1]
    if total == 0:
        return t
    n = max(2, int(np.ceil(total / spacing_m)) + 1)
    s = np.linspace(0, total, n)
    keep = np.r_[True, np.diff(cd) > 0]  # drop zero-length steps for interp
    cdk = cd[keep]
    lat = np.interp(s, cdk, t.lat[keep])
    lon = np.interp(s, cdk, t.lon[keep])
    e = t.ele[keep]
    ok = ~np.isnan(e)
    ele = np.interp(s, cdk[ok], e[ok]) if ok.sum() >= 2 else np.full(n, np.nan)
    return Track(t.name, lat, lon, ele, t.ele_source, list(t.notes))


# ---------------------------------------------------------------- stats

def gain_loss_m(ele: np.ndarray, threshold_m: float = 3.0) -> tuple[float, float]:
    """Hysteresis gain/loss: ignores wiggles smaller than threshold (default ~10 ft)."""
    e = ele[~np.isnan(ele)]
    if e.size < 2:
        return 0.0, 0.0
    gain = loss = 0.0
    ref = e[0]
    for v in e[1:]:
        if v - ref >= threshold_m:
            gain += v - ref
            ref = v
        elif ref - v >= threshold_m:
            loss += ref - v
            ref = v
    return gain, loss


def stats(t: Track, threshold_ft: float = 10.0) -> dict:
    cd = cumdist_m(t)
    g, l = gain_loss_m(t.ele, threshold_ft / FT_PER_M)
    e = t.ele[~np.isnan(t.ele)]
    out = {
        "distance_mi": round(cd[-1] / M_PER_MI, 2),
        "gain_ft": round(g * FT_PER_M),
        "loss_ft": round(l * FT_PER_M),
        "points": len(t),
        "elevation_source": t.ele_source,
        "start": [round(float(t.lat[0]), 6), round(float(t.lon[0]), 6)],
        "end": [round(float(t.lat[-1]), 6), round(float(t.lon[-1]), 6)],
        "start_to_end_ft": round(float(haversine_m(t.lat[0], t.lon[0], t.lat[-1], t.lon[-1])) * FT_PER_M),
    }
    if e.size:
        out["min_ele_ft"] = round(float(e.min()) * FT_PER_M)
        out["max_ele_ft"] = round(float(e.max()) * FT_PER_M)
        missing = int(np.isnan(t.ele).sum())
        if missing:
            out["points_missing_elevation"] = missing
    if t.ele_source in ("gps", "mixed"):
        out["warning"] = "Elevation is from GPS recordings; gain is often inflated. Run elevate_track for DEM values."
    elif t.ele_source == "none":
        out["warning"] = "No elevation data; run elevate_track to get gain."
    return out
