import asyncio
from pathlib import Path

import numpy as np
import pytest

from gpx_stitch.geo import M_PER_MI, FT_PER_M, Track, clip, cumdist_m, resample, stats, stitch
from gpx_stitch.remote import fetch_gpx
from gpx_stitch.server import Config, build_server
from gpx_stitch.store import TrackStore, parse_gpx, to_gpx

# A straight N-S "trail": 201 pts, ~6.9 mi, climbing 2500 -> 3500 m
N = 201
BASE_LAT = np.linspace(37.0, 37.1, N)
BASE_LON = np.full(N, -118.5)
BASE_ELE = np.linspace(2500, 3500, N)
BASE_MI = cumdist_m(Track("b", BASE_LAT, BASE_LON, BASE_ELE))[-1] / M_PER_MI


def piece(i, j, name="p", reverse=False, jitter=0.0):
    t = Track(name, BASE_LAT[i:j].copy(), BASE_LON[i:j] + jitter, BASE_ELE[i:j].copy())
    return t.reversed() if reverse else t


def test_overlap_is_trimmed():
    out, joins = stitch([piece(0, 110, "A"), piece(80, 201, "B")], "AB")
    assert joins[0]["bridge"] == "snapped"
    assert joins[0]["trimmed_prev_ft"] > 0 or joins[0]["trimmed_next_ft"] > 0
    assert abs(stats(out)["distance_mi"] - BASE_MI) < 0.05
    assert len(out) == N  # no duplicated points


def test_reversed_pieces_get_flipped():
    out, joins = stitch([piece(0, 110, "A", reverse=True), piece(100, 201, "B", reverse=True)], "AB")
    d = stats(out)["distance_mi"]
    assert abs(d - BASE_MI) < 0.05
    # whole thing runs consistently in one direction (monotonic latitude)
    assert np.all(np.diff(out.lat) >= 0) or np.all(np.diff(out.lat) <= 0)


def test_three_pieces_mixed_orientation():
    segs = [piece(0, 70, "A"), piece(65, 140, "B", reverse=True), piece(135, 201, "C")]
    out, joins = stitch(segs, "ABC")
    assert [j["flipped"] for j in joins] == [True, False]
    assert abs(stats(out)["distance_mi"] - BASE_MI) < 0.05


def test_gap_bridged_straight():
    out, joins = stitch([piece(0, 100, "A"), piece(130, 201, "B")], "AB", gap_mode="straight")
    j = joins[0]
    assert j["bridge"] == "straight"
    assert 5400 < j["bridge_ft"] < 5900  # 31 steps x ~182 ft
    assert abs(stats(out)["distance_mi"] - BASE_MI) < 0.05


def test_gap_routed_uses_router_and_falls_back():
    calls = []

    def router(a, b, c, d):
        calls.append((a, b, c, d))
        mid_lat = (a + c) / 2
        return np.array([a, mid_lat, c]), np.array([b, b + 0.01, d])  # detour east

    out, joins = stitch([piece(0, 100), piece(130, 201)], "AB", gap_mode="route", router=router)
    assert calls and joins[0]["bridge"] == "routed"
    assert stats(out)["distance_mi"] > BASE_MI  # detour adds distance

    out2, joins2 = stitch([piece(0, 100), piece(130, 201)], "AB", gap_mode="route", router=lambda *a: None)
    assert joins2[0]["bridge"] == "straight" and "note" in joins2[0]


def test_auto_mode_small_gap_stays_straight():
    called = []
    _, joins = stitch([piece(0, 100), piece(102, 201)], "AB", gap_mode="auto", snap_m=30,
                      straight_max_m=500, router=lambda *a: called.append(a))
    assert joins[0]["bridge"] == "straight" and not called


def test_clip_forward_and_reverse():
    t = piece(0, 201)
    out, info = clip(t, (BASE_LAT[150], -118.5), (BASE_LAT[50], -118.5))
    assert info["reversed"] and len(out) == 101
    assert out.lat[0] > out.lat[-1]
    with pytest.raises(ValueError):
        clip(t, (37.05, -118.5), (37.05, -118.5))


def test_gain_ignores_jitter():
    rng = np.random.default_rng(0)
    noisy = BASE_ELE + rng.normal(0, 0.8, N)  # ~2.6 ft sigma noise
    t = Track("n", BASE_LAT, BASE_LON, noisy)
    g = stats(t)["gain_ft"]
    assert abs(g - 1000 * FT_PER_M) < 60  # ~3,281 ft


def test_resample_spacing_and_elevation():
    r = resample(piece(0, 201), 30.0)
    steps = np.diff(cumdist_m(r))
    assert np.allclose(steps, steps.mean(), rtol=1e-3) and 29 < steps.mean() <= 30
    assert abs(r.ele[0] - 2500) < 1e-6 and abs(r.ele[-1] - 3500) < 1e-6


def test_gpx_roundtrip_and_route_only_files():
    t = piece(0, 50, "Round trip")
    back = parse_gpx(to_gpx(t))
    assert back.name == "Round trip" and len(back) == 50
    rte = """<?xml version="1.0"?><gpx version="1.1" creator="x"><rte><name>R</name>
      <rtept lat="37.0" lon="-118.5"/><rtept lat="37.01" lon="-118.5"/></rte></gpx>"""
    r = parse_gpx(rte)
    assert r.name == "R" and r.ele_source == "none"


def test_fetch_blocks_private_hosts():
    for url in ("http://169.254.169.254/metadata/v1", "http://localhost:8790/x", "file:///etc/passwd"):
        with pytest.raises(ValueError):
            asyncio.run(fetch_gpx(url))


# ---------------------------------------------------------------- server end to end

class FakeElevation:
    provider = "fake"

    async def lookup(self, lat, lon):
        return 2500 + (lat - 37.0) / 0.1 * 1000  # same profile as BASE_ELE


class NoRouter:
    available = False

    def route(self, *a):
        return None


def _data(res):
    import json
    if getattr(res, "is_error", False):
        raise AssertionError(f"tool error: {res.content[0].text}")
    if getattr(res, "structured_content", None) is not None:
        return res.structured_content
    return json.loads(res.content[0].text)


def test_server_end_to_end(tmp_path: Path):
    cfg = Config(tmp_path / "data", tmp_path / "inbox", tmp_path / "out")
    mcp = build_server(cfg, TrackStore(cfg.data_dir), FakeElevation(), NoRouter())
    (cfg.inbox_dir / "b.gpx").write_text(to_gpx(piece(95, 201, "Upper", reverse=True)))

    async def run():
        a = _data(await mcp.call_tool("load_track", {"gpx_text": to_gpx(piece(0, 105, "Lower"))}))
        b = _data(await mcp.call_tool("load_track", {"source": str(cfg.inbox_dir / "b.gpx")}))
        from mcp.server.mcpserver.exceptions import ToolError
        with pytest.raises(ToolError, match="inside one of"):
            await mcp.call_tool("load_track", {"source": "/etc/passwd"})
        bad = None
        s = _data(await mcp.call_tool("stitch_tracks", {"track_ids": [a["track_id"], b["track_id"]],
                                                        "name": "Lower + Upper"}))
        e = _data(await mcp.call_tool("elevate_track", {"track_id": s["track_id"]}))
        x = _data(await mcp.call_tool("export_gpx", {"track_id": s["track_id"]}))
        return a, b, bad, s, e, x

    a, b, bad, s, e, x = asyncio.run(run())
    assert s["joins"][0]["flipped"] is True and "note" in s  # no ORS key note
    assert e["elevation_source"] == "dem" and abs(e["gain_ft"] - 3281) < 40
    assert abs(e["distance_mi"] - BASE_MI) < 0.05
    p = Path(x["path"])
    assert p.exists() and p.parent == cfg.export_dir and p.name == "lower-upper.gpx"
    assert "ft gain" in p.read_text()

    # store survives restart
    store2 = TrackStore(cfg.data_dir)
    assert len(store2.items()) == 3
