"""HTTP-layer behaviour, on fake providers via the FastAPI test client.

Most coverage lives at the engine level; these tests pin the contract the frontend
depends on -- shapes, status codes, and the config/reindex round trip.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from clearrag.api import app as appmod
from clearrag.config import PipelineConfig, Settings
from clearrag.pipeline import Engine
from clearrag.providers.fake import FakeChat, FakeEmbeddings


@pytest.fixture
def client(tmp_path):
    settings = Settings(workspace=tmp_path / "ws")
    config = PipelineConfig(chunk_size=64, chunk_overlap=8, k_candidates=10, k_final=3)
    appmod.state.settings = settings
    appmod.state.config = config
    appmod.state.engine = Engine(settings, config, chat=FakeChat(), embeddings=FakeEmbeddings())
    with TestClient(appmod.app) as c:
        yield c
    appmod.state.engine = None


def test_config_round_trip_reports_when_a_reindex_is_needed(client):
    ingest_change = client.put("/api/config", json={"chunk_size": 256}).json()
    assert ingest_change["reindex_needed"] is True

    query_change = client.put("/api/config", json={"k_final": 5}).json()
    assert query_change["reindex_needed"] is False


def test_invalid_config_is_rejected_not_applied(client):
    before = client.get("/api/config").json()["config_hash"]
    response = client.put("/api/config", json={"chunk_size": -1})
    assert response.status_code == 422
    assert client.get("/api/config").json()["config_hash"] == before


def test_sample_corpus_loads_and_is_idempotent(client):
    first = client.post("/api/documents/sample").json()
    assert first["indexed"] >= 8, "the bundled corpus should be substantial"
    assert first["unchanged"] == 0

    second = client.post("/api/documents/sample").json()
    assert second["indexed"] == 0
    assert second["unchanged"] == first["indexed"]


def test_reindex_round_trip_changes_chunk_counts(client):
    client.post("/api/documents/sample")
    before = client.get("/api/health").json()["chunks"]

    client.put("/api/config", json={"chunk_size": 512, "chunk_overlap": 0})
    report = client.post("/api/reindex").json()

    assert report["status"] == "reindexed"
    assert report["total_chunks"] == client.get("/api/health").json()["chunks"]
    assert report["total_chunks"] < before


def test_chat_streams_context_with_position_metadata(client):
    """The retrieval table identifies chunks by position; the event must carry it."""
    client.post("/api/documents/sample")
    with client.stream(
        "POST", "/api/chat", json={"question": "How do I roll back a release?", "history": []}
    ) as response:
        import json

        events = [
            json.loads(line[6:]) for line in response.iter_lines() if line.startswith("data: ")
        ]
    context = next(e for e in events if e["type"] == "context")
    for chunk in context["chunks"]:
        assert {"marker", "chunk_id", "filename", "ordinal", "span"} <= chunk.keys()
    assert events[-1]["type"] == "done"


def test_map_projects_the_corpus_and_a_query(client):
    client.post("/api/documents/sample")
    plain = client.get("/api/map").json()
    assert len(plain["points"]) >= 10
    assert plain["query"] is None
    for point in plain["points"]:
        assert -1.001 <= point["x"] <= 1.001 and -1.001 <= point["y"] <= 1.001
        assert {"chunk_id", "filename", "ordinal"} <= point.keys()

    with_query = client.get("/api/map", params={"query": "how do I roll back a release?"}).json()
    assert with_query["query"] is not None
    assert 1 <= len(with_query["neighbours"]) <= 5
    ids = {p["chunk_id"] for p in with_query["points"]}
    assert set(with_query["neighbours"]) <= ids


def test_map_refuses_a_near_empty_corpus(client):
    assert client.get("/api/map").status_code == 409


def test_runtime_endpoint_degrades_to_a_readout_when_ollama_is_absent(client):
    """The fake-provider test client has no Ollama behind it. The endpoint must still
    answer 200 with an honest "unavailable" rather than failing the page."""
    body = client.get("/api/runtime").json()
    assert body["available"] in (True, False)
    assert isinstance(body["models"], list)


def test_provider_update_switches_chat_model_and_drops_the_engine(client):
    response = client.put("/api/providers", json={"chat_model": "qwen3.5:9b"})
    assert response.status_code == 200
    body = response.json()
    assert body["providers"]["chat"]["model"] == "qwen3.5:9b"
    assert body["reindex_needed"] is False
    # The engine is rebuilt lazily with the new provider settings.
    assert appmod.state.engine is None
    assert client.get("/api/config").json()["providers"]["chat"]["model"] == "qwen3.5:9b"


def test_provider_update_flags_embed_change_as_reindex(client):
    response = client.put("/api/providers", json={"embed_model": "mxbai-embed-large"})
    assert response.json()["reindex_needed"] is True


def test_provider_update_rejects_unknown_and_empty_values(client):
    assert client.put("/api/providers", json={"chat_provider": "openai"}).status_code == 422
    assert client.put("/api/providers", json={"chat_model": "  "}).status_code == 422


def test_model_splitting_buckets_by_capability_with_name_fallback():
    from clearrag.api.app import _split_models

    split = _split_models(
        [
            ("llama3.2:latest", ["completion", "tools"]),
            ("nomic-embed-text:latest", ["embedding"]),
            ("qwen3.5:9b", ["completion", "vision"]),
            # capabilities unavailable -> naming convention decides
            ("mxbai-embed-large", None),
            ("mystery-model", None),
        ]
    )
    assert split["chat"] == ["llama3.2:latest", "mystery-model", "qwen3.5:9b"]
    assert split["embedding"] == ["mxbai-embed-large", "nomic-embed-text:latest"]
