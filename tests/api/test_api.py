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


def test_sample_sets_report_indexed_counts(client):
    listing = client.get("/api/samples").json()
    ids = {s["id"] for s in listing}
    assert "dev-docs" in ids
    dev = next(s for s in listing if s["id"] == "dev-docs")
    assert dev["indexed_count"] == 0 and dev["file_count"] >= 8

    client.post("/api/documents/sample")
    dev = next(s for s in client.get("/api/samples").json() if s["id"] == "dev-docs")
    assert dev["indexed_count"] == dev["file_count"]


def test_sample_set_import_streams_progress_then_a_summary(client):
    import json

    with client.stream("POST", "/api/samples/dev-docs") as response:
        events = [
            json.loads(line[6:]) for line in response.iter_lines() if line.startswith("data: ")
        ]
    files = [e for e in events if e["type"] == "file"]
    assert len(files) >= 8
    assert events[0] == {"type": "start", "filenames": [f["filename"] for f in files]}
    assert [f["index"] for f in files] == list(range(len(files)))
    assert all(f["total"] == len(files) for f in files)
    assert events[-1] == {"type": "done", "indexed": len(files), "unchanged": 0}


def test_sample_set_import_resumes_by_skipping_indexed_files(client):
    """A stopped import picks up where it left off: files already in the store are
    skipped by filename, without re-parsing or re-embedding them."""
    import json

    client.post("/api/documents/sample")
    victim = client.get("/api/documents").json()[0]
    client.delete(f"/api/documents/{victim['id']}")

    with client.stream("POST", "/api/samples/dev-docs") as response:
        events = [
            json.loads(line[6:]) for line in response.iter_lines() if line.startswith("data: ")
        ]
    total = len([e for e in events if e["type"] == "file"])
    assert events[-1] == {"type": "done", "indexed": 1, "unchanged": total - 1}


def test_sample_set_removal_only_touches_that_set(client):
    client.post("/api/documents/sample")
    client.post("/api/documents", files={"files": ("mine.md", b"# Mine\n\nMy own document.")})

    report = client.delete("/api/samples/dev-docs").json()
    assert report["removed"] >= 8 and report["chunks_removed"] > 0

    remaining = client.get("/api/documents").json()
    assert [d["filename"] for d in remaining] == ["mine.md"]

    assert client.delete("/api/samples/nope").status_code == 404


def test_clear_documents_empties_the_index(client):
    client.post("/api/documents/sample")
    report = client.delete("/api/documents").json()
    assert report["removed"] >= 8 and report["chunks_removed"] > 0
    assert client.get("/api/documents").json() == []
    assert client.get("/api/health").json()["chunks"] == 0


def test_reindex_round_trip_changes_chunk_counts(client):
    client.post("/api/documents/sample")
    before = client.get("/api/health").json()["chunks"]

    client.put("/api/config", json={"chunk_size": 512, "chunk_overlap": 0})
    report = client.post("/api/reindex").json()

    assert report["status"] == "reindexed"
    assert report["total_chunks"] == client.get("/api/health").json()["chunks"]
    assert report["total_chunks"] < before


def _chat_events(client, body):
    import json

    with client.stream("POST", "/api/chat", json=body) as response:
        return [json.loads(line[6:]) for line in response.iter_lines() if line.startswith("data: ")]


def test_sessions_list_auto_creates_a_default_unscoped_session(client):
    sessions = client.get("/api/sessions").json()
    assert len(sessions) == 1
    assert sessions[0]["title"] == "New chat"
    assert sessions[0]["doc_ids"] is None
    # Idempotent: a second list does not mint another default.
    assert len(client.get("/api/sessions").json()) == 1


def test_session_crud_round_trip(client):
    created = client.post("/api/sessions", json={"doc_ids": ["d_x"]}).json()
    assert created["doc_ids"] == ["d_x"]

    renamed = client.patch(f"/api/sessions/{created['id']}", json={"title": "SEC only"}).json()
    assert renamed["title"] == "SEC only" and renamed["doc_ids"] == ["d_x"]

    widened = client.patch(f"/api/sessions/{created['id']}", json={"all_documents": True}).json()
    assert widened["doc_ids"] is None

    assert client.delete(f"/api/sessions/{created['id']}").json() == {"deleted": created["id"]}
    assert client.get(f"/api/sessions/{created['id']}").status_code == 404


def test_chat_persists_messages_and_titles_the_session(client):
    client.post("/api/documents/sample")
    session = client.post("/api/sessions", json={}).json()

    events = _chat_events(
        client,
        {"question": "How do I roll back a release?", "history": [], "session_id": session["id"]},
    )
    assert events[-1]["type"] == "done"

    detail = client.get(f"/api/sessions/{session['id']}").json()
    assert detail["title"] == "How do I roll back a release?"
    roles = [m["role"] for m in detail["messages"]]
    assert roles == ["user", "assistant"]
    assistant = detail["messages"][1]
    assert assistant["trace"] is not None
    assert assistant["trace"]["id"] == assistant["trace_id"]
    assert assistant["content"] == assistant["trace"]["answer"]


def test_traces_are_scoped_per_session(client):
    client.post("/api/documents/sample")
    first = client.post("/api/sessions", json={}).json()
    second = client.post("/api/sessions", json={}).json()
    _chat_events(
        client, {"question": "How do I roll back?", "history": [], "session_id": first["id"]}
    )

    assert len(client.get(f"/api/traces?session_id={first['id']}").json()) == 1
    assert client.get(f"/api/traces?session_id={second['id']}").json() == []
    assert len(client.get("/api/traces").json()) == 1


def test_scoped_session_only_retrieves_from_its_documents(client):
    client.post("/api/documents/sample")
    documents = client.get("/api/documents").json()
    target = next(d for d in documents if d["filename"] == "deployment.md")

    session = client.post("/api/sessions", json={"doc_ids": [target["id"]]}).json()
    events = _chat_events(
        client,
        {"question": "How do I roll back a release?", "history": [], "session_id": session["id"]},
    )
    context = next(e for e in events if e["type"] == "context")
    assert context["chunks"], "the scoped corpus should still retrieve"
    assert {c["doc_id"] for c in context["chunks"]} == {target["id"]}


def test_scoped_session_with_no_indexed_documents_errors_helpfully(client):
    client.post("/api/documents/sample")
    session = client.post("/api/sessions", json={"doc_ids": ["d_gone"]}).json()
    events = _chat_events(
        client, {"question": "anything", "history": [], "session_id": session["id"]}
    )
    assert events[-1]["type"] == "error"
    assert "scope" in events[-1]["remedy"]


def test_reindex_stream_reports_per_document_progress(client):
    import json

    client.post("/api/documents/sample")
    with client.stream("POST", "/api/reindex/stream") as response:
        events = [
            json.loads(line[6:]) for line in response.iter_lines() if line.startswith("data: ")
        ]
    docs = [e for e in events if e["type"] == "doc"]
    assert events[0]["type"] == "start" and len(events[0]["filenames"]) == len(docs)
    assert [d["index"] for d in docs] == list(range(len(docs)))
    done = events[-1]
    assert done["type"] == "done" and done["status"] == "reindexed"
    assert done["total_chunks"] == client.get("/api/health").json()["chunks"]


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
