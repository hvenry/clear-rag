"""Trace mechanics, including the credential-redaction guard."""

from __future__ import annotations

from clearrag.core.trace import Trace, redact
from clearrag.core.types import Candidate


def test_redacts_credentials():
    out = redact({"model": "llama3.2", "api_key": "sk-secret", "auth_token": "t"})
    assert out["model"] == "llama3.2"
    assert out["api_key"] == "***"
    assert out["auth_token"] == "***"


def test_redacts_nested_credentials():
    out = redact({"provider": {"name": "openai", "openai_api_key": "sk-secret"}})
    assert out["provider"]["openai_api_key"] == "***"
    assert out["provider"]["name"] == "openai"


def test_absent_credential_is_not_masked_into_a_lie():
    assert redact({"api_key": ""})["api_key"] is None


def test_stage_is_appended_immediately_so_failures_are_visible():
    trace = Trace(query="q")
    record = trace.stage("bm25", "Keyword search")
    assert trace.stages == [record]
    assert trace.find("bm25") is record


def test_serialised_trace_carries_candidates():
    trace = Trace(query="q")
    record = trace.stage("bm25", "Keyword search")
    record.candidates_out = [Candidate(chunk_id="c1", score=1.5, rank=1, source="bm25")]

    stage = trace.to_dict()["stages"][0]
    assert stage["candidates_out"][0]["chunk_id"] == "c1"
    assert stage["candidates_in"] is None


def test_serialised_config_is_redacted():
    trace = Trace(query="q")
    trace.stage("generate", "Generate", model="claude-opus-5", api_key="sk-secret")
    assert trace.to_dict()["stages"][0]["config"]["api_key"] == "***"
