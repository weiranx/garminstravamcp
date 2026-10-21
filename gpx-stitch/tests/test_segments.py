import asyncio

import pytest
from mcp.server.mcpserver.exceptions import ToolError

from gpx_stitch.server import Config, build_server
from gpx_stitch.store import TrackStore, parse_gpx, to_gpx


POINTS = '<trkpt lat="37" lon="-118"/><trkpt lat="37.01" lon="-118"/>'
FAR_POINTS = '<trkpt lat="40" lon="-120"/><trkpt lat="40.01" lon="-120"/>'
SEGMENT = f'<trkseg>{POINTS}</trkseg>'
FAR_SEGMENT = f'<trkseg>{FAR_POINTS}</trkseg>'
MULTIPLE = [
    f'<trk>{SEGMENT}{FAR_SEGMENT}</trk>',
    f'<trk>{SEGMENT}</trk><trk>{FAR_SEGMENT}</trk>',
    '<rte><rtept lat="37" lon="-118"/><rtept lat="37.01" lon="-118"/></rte>'
    '<rte><rtept lat="40" lon="-120"/><rtept lat="40.01" lon="-120"/></rte>',
    f'<trk>{SEGMENT}<trkseg><trkpt lat="40" lon="-120"/></trkseg></trk>',
]


def gpx(body):
    return f'<gpx version="1.1" creator="test">{body}</gpx>'


@pytest.mark.parametrize('body', MULTIPLE)
def test_reject_discontinuous_segments_tracks_and_routes(body):
    with pytest.raises(ValueError, match='split them into separate GPX files.*stitch_tracks'):
        parse_gpx(gpx(body))


def test_ignore_empty_segments_and_preserve_continuous_roundtrip():
    track = parse_gpx(gpx(f'<trk><trkseg/>{SEGMENT}<trkseg/></trk><trk/>'))
    assert len(track) == 2
    restored = parse_gpx(to_gpx(track))
    assert list(restored.lat) == [37, 37.01]


@pytest.mark.parametrize('body', MULTIPLE[:3])
def test_load_rejects_before_persisting_and_surfaces_actionable_error(tmp_path, body):
    cfg = Config(tmp_path / 'data', tmp_path / 'inbox', tmp_path / 'out')
    store = TrackStore(cfg.data_dir)
    server = build_server(cfg, store, None, None)
    with pytest.raises(ToolError, match='split them into separate GPX files'):
        asyncio.run(server.call_tool('load_track', {'gpx_text': gpx(body)}))
    assert store.items() == []
    assert list(store.dir.iterdir()) == []
