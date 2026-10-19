from pathlib import Path

import yaml


def test_gpx_is_opt_in_and_callback_allowlist_reaches_proxy():
    compose = yaml.safe_load((Path(__file__).parents[2] / 'docker-compose.yml').read_text())
    services = compose['services']
    default_services = {name for name, service in services.items() if not service.get('profiles')}
    assert default_services == {'autoheal', 'garmin-mcp', 'strava-mcp', 'coros-mcp'}
    assert services['gpx-mcp']['profiles'] == ['gpx']
    enabled = default_services | {name for name, service in services.items()
                                  if 'gpx' in service.get('profiles', [])}
    assert enabled == set(services)
    assert 'GPX_OAUTH_REDIRECT_URIS=${GPX_OAUTH_REDIRECT_URIS:-}' in services['gpx-mcp']['environment']
