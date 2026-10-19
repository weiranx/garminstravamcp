"""Network clients: safe GPX download, DEM elevation, trail routing for gap bridging."""
from __future__ import annotations

import asyncio
import ipaddress
import socket
from urllib.parse import urlparse

import httpx
import numpy as np

MAX_GPX_BYTES = 25 * 1024 * 1024
UA = "gpx-stitch/0.1 (self-hosted MCP)"


# ---------------------------------------------------------------- GPX download

def _check_public_host(url: str) -> None:
    """Block loopback/private/link-local targets (e.g. the droplet metadata service)."""
    u = urlparse(url)
    if u.scheme not in ("http", "https") or not u.hostname:
        raise ValueError("only http(s) URLs are allowed")
    for info in socket.getaddrinfo(u.hostname, u.port or (443 if u.scheme == "https" else 80)):
        ip = ipaddress.ip_address(info[4][0])
        if not ip.is_global:
            raise ValueError(f"refusing to fetch non-public address {ip}")


async def fetch_gpx(url: str, client: httpx.AsyncClient | None = None) -> str:
    own = client is None
    client = client or httpx.AsyncClient(timeout=30, headers={"User-Agent": UA})
    try:
        for _ in range(5):  # follow redirects manually so every hop is checked
            await asyncio.to_thread(_check_public_host, url)
            async with client.stream("GET", url, follow_redirects=False) as r:
                if r.is_redirect:
                    url = str(r.url.join(r.headers["location"]))
                    continue
                r.raise_for_status()
                buf = bytearray()
                async for chunk in r.aiter_bytes():
                    buf += chunk
                    if len(buf) > MAX_GPX_BYTES:
                        raise ValueError("GPX download exceeds 25 MB")
                text = buf.decode(r.encoding or "utf-8", errors="replace")
                if "<gpx" not in text[:4096]:
                    raise ValueError("URL did not return a GPX file (may need a login; download it "
                                     "manually into the inbox folder instead)")
                return text
        raise ValueError("too many redirects")
    finally:
        if own:
            await client.aclose()


# ---------------------------------------------------------------- elevation

class Elevation:
    """DEM elevation in meters.

    provider "opentopodata": batched (100 pts/request). Default dataset ned10m is
    USGS 3DEP 1/3 arc-second (~10 m) for the US. Public API allows ~1 req/s, 1000/day.
    provider "usgs": USGS EPQS, one point per request (slower, no daily cap).
    """

    def __init__(self, provider: str = "opentopodata", base_url: str = "https://api.opentopodata.org",
                 dataset: str = "ned10m", client: httpx.AsyncClient | None = None,
                 min_interval_s: float = 1.05):
        self.provider = provider
        self.base_url = base_url.rstrip("/")
        self.dataset = dataset
        self.client = client or httpx.AsyncClient(timeout=60, headers={"User-Agent": UA})
        self.min_interval_s = min_interval_s

    async def lookup(self, lat: np.ndarray, lon: np.ndarray) -> np.ndarray:
        if self.provider == "usgs":
            return await self._usgs(lat, lon)
        return await self._otd(lat, lon)

    async def _otd(self, lat, lon) -> np.ndarray:
        out = np.full(len(lat), np.nan)
        for k in range(0, len(lat), 100):
            locs = "|".join(f"{a:.6f},{o:.6f}" for a, o in zip(lat[k:k + 100], lon[k:k + 100]))
            for attempt in range(4):
                r = await self.client.post(f"{self.base_url}/v1/{self.dataset}", data={"locations": locs})
                if r.status_code == 429:
                    await asyncio.sleep(2 ** attempt)
                    continue
                r.raise_for_status()
                break
            else:
                raise RuntimeError("elevation API rate-limited; try again later or self-host OpenTopoData")
            res = r.json()["results"]
            out[k:k + len(res)] = [np.nan if x["elevation"] is None else x["elevation"] for x in res]
            if k + 100 < len(lat) and self.min_interval_s:
                await asyncio.sleep(self.min_interval_s)
        return out

    async def _usgs(self, lat, lon, concurrency: int = 8) -> np.ndarray:
        sem = asyncio.Semaphore(concurrency)

        async def one(a, o):
            async with sem:
                r = await self.client.get("https://epqs.nationalmap.gov/v1/json",
                                          params={"x": o, "y": a, "units": "Meters", "wkid": 4326})
                r.raise_for_status()
                v = r.json().get("value")
                try:
                    v = float(v)
                except (TypeError, ValueError):
                    return np.nan
                return np.nan if v < -1000 else v

        return np.array(await asyncio.gather(*(one(a, o) for a, o in zip(lat, lon))))


# ---------------------------------------------------------------- routing

class Router:
    """OpenRouteService foot-hiking routing for bridging gaps between tracks.

    Synchronous on purpose: stitching runs in a worker thread and calls this per gap.
    """

    def __init__(self, api_key: str | None, base_url: str = "https://api.openrouteservice.org",
                 profile: str = "foot-hiking", client: httpx.Client | None = None):
        self.api_key = api_key
        self.base_url = base_url.rstrip("/")
        self.profile = profile
        self.client = client or httpx.Client(timeout=30, headers={"User-Agent": UA})

    @property
    def available(self) -> bool:
        return bool(self.api_key)

    def route(self, lat1, lon1, lat2, lon2):
        if not self.available:
            return None
        try:
            r = self.client.post(
                f"{self.base_url}/v2/directions/{self.profile}/geojson",
                headers={"Authorization": self.api_key},
                json={"coordinates": [[float(lon1), float(lat1)], [float(lon2), float(lat2)]]})
            r.raise_for_status()
            coords = r.json()["features"][0]["geometry"]["coordinates"]
        except Exception:
            return None
        arr = np.array(coords, dtype=float)
        return arr[:, 1], arr[:, 0]
