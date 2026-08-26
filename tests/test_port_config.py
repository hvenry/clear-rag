"""The port knob: one source of truth shared by the backend, the Vite proxy and compose.

A port that lives in five files is a port that silently disagrees with itself. The Vite
proxy hardcoded 8000 while ``Settings.port`` read CLEARRAG_PORT, so ``make dev`` proxied
/api into whatever unrelated process happened to own 8000 -- which presents exactly like
a backend that never started.
"""

from clearrag.config import Settings
from tests.conftest import REPO_ROOT

#: Deliberately not 8000. That port is the default for Django, http.server, uvicorn's own
#: docs and half the containers on a working laptop, so it is the one most likely to be
#: taken by something that answers with a plausible-looking 404 rather than refusing.
DEFAULT_PORT = 8010


def test_default_port_avoids_the_crowded_8000(monkeypatch):
    monkeypatch.delenv("CLEARRAG_PORT", raising=False)
    assert Settings(_env_file=None).port == DEFAULT_PORT


def test_port_env_override_reaches_settings(monkeypatch):
    """Regression guard on existing pydantic-settings behaviour the rest of this relies on."""
    monkeypatch.setenv("CLEARRAG_PORT", "9123")
    assert Settings(_env_file=None).port == 9123


def test_vite_proxy_derives_its_target_from_the_env():
    source = (REPO_ROOT / "web" / "vite.config.ts").read_text()
    assert "CLEARRAG_PORT" in source, "Vite proxy must read the port, not assume one"
    assert "8000" not in source, "hardcoded 8000 in the proxy target"


def test_compose_publishes_the_configured_port():
    source = (REPO_ROOT / "docker-compose.yml").read_text()
    assert "CLEARRAG_PORT" in source, "compose must publish the configured port"
    assert '"8000:8000"' not in source, "hardcoded port mapping"


def test_dockerfile_healthcheck_uses_the_configured_port():
    """EXPOSE stays literal -- it is documentation. The healthcheck actually connects."""
    healthcheck = [
        line
        for line in (REPO_ROOT / "Dockerfile").read_text().splitlines()
        if "urllib.request.urlopen" in line
    ]
    assert healthcheck, "expected a healthcheck that opens a URL"
    assert "8000" not in healthcheck[0], "healthcheck probes a hardcoded port"
