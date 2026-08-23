"""Configuration.

Two objects with different lifetimes:

``Settings`` is process configuration -- where the workspace lives, which provider URLs
and keys to use. It comes from the environment and does not change while running.

``PipelineConfig`` is *experiment* configuration -- the knobs that change retrieval
behaviour. Its ``config_hash`` is stamped onto every trace, which is what turns the
ablation table into a GROUP BY: every recorded query is attributable to the exact
configuration that produced it.

Deliberately flat. A declarative DAG would be more general and would also be a different
project; the stage list here is fixed and hand-written, and this model only parameterises it.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class PipelineConfig(BaseModel):
    """Everything that changes what retrieval does."""

    model_config = {"frozen": True}

    # ── Ingestion ──
    chunker: Literal["recursive", "semantic"] = "recursive"
    chunk_size: int = Field(512, ge=64, le=4096, description="Target chunk size in tokens.")
    chunk_overlap: int = Field(
        64,
        ge=0,
        le=1024,
        description="Overlap in tokens. 12% of chunk_size, not the 50% the predecessor used: "
        "high overlap inflates the index and fills top-k with near-duplicates.",
    )
    contextualize: bool = Field(
        False, description="Phase 3: prepend an LLM-written situating sentence to each chunk."
    )

    # ── Retrieval ──
    retrieval: Literal["dense", "lexical", "hybrid"] = "hybrid"
    k_candidates: int = Field(
        50, ge=1, le=500, description="Candidates per retriever before fusion."
    )
    fusion: Literal["rrf", "weighted"] = "rrf"
    rrf_k: int = Field(
        60, ge=1, description="RRF damping constant; 60 is the value from the paper."
    )
    dense_weight: float = Field(
        0.5, ge=0.0, le=1.0, description="Only used when fusion='weighted'."
    )

    # ── Reranking ──
    rerank: bool = Field(
        False,
        description=(
            "Cross-encoder reranking of the fused shortlist (ms-marco-MiniLM via ONNX, "
            "~23 MB downloaded on first use). Off by default because it adds a few hundred "
            "milliseconds; when the optional dependencies are missing the stage reports "
            "itself as skipped rather than failing the query."
        ),
    )
    k_final: int = Field(5, ge=1, le=50, description="Chunks handed to the generator.")

    # ── Query understanding ──
    query_transform: Literal["none", "hyde", "multi"] = "none"
    self_correct: bool = Field(False, description="Phase 4: grade retrieval, rewrite, retry once.")
    rewrite_followups: bool = Field(
        True,
        description="Rewrite follow-up questions into standalone queries. The prompt rewrites "
        "rather than answers -- the predecessor project got this backwards and searched its "
        "index with a hallucinated answer from turn two onward.",
    )

    # ── Generation ──
    max_context_tokens: int = Field(4096, ge=256, description="Budget for packed context.")
    temperature: float = Field(0.1, ge=0.0, le=2.0)

    @property
    def config_hash(self) -> str:
        """Stable short hash of the full configuration."""
        payload = json.dumps(self.model_dump(), sort_keys=True).encode()
        return hashlib.sha256(payload).hexdigest()[:12]


#: Checked in order, first match wins. A bare ".env" is relative to the working
#: directory, so starting the server from anywhere but the project root would silently
#: ignore the file and fall back to defaults -- which looks exactly like "my model
#: setting did nothing".
_ENV_FILES = (".env", str(Path(__file__).resolve().parents[2] / ".env"))


class Settings(BaseSettings):
    """Process configuration, read from the environment."""

    model_config = SettingsConfigDict(
        env_prefix="CLEARRAG_", env_file=_ENV_FILES, extra="ignore", case_sensitive=False
    )

    workspace: Path = Path("./workspace")
    host: str = "127.0.0.1"
    port: int = 8000

    # Ollama is the default and requires no credentials.
    ollama_url: str = "http://localhost:11434"
    chat_model: str = "llama3.2"
    embed_model: str = "nomic-embed-text"

    # Bring your own key. Blank means "stay local".
    openai_api_key: str = ""
    openai_base_url: str = "https://api.openai.com/v1"
    anthropic_api_key: str = ""

    think: bool = False
    """Let a reasoning model think before answering. Off by default -- see OllamaChat."""

    # ── Local inference tuning (Ollama) ──
    # These are process settings rather than PipelineConfig knobs on purpose: they change
    # how fast an answer arrives, never what the pipeline retrieves, so they must not
    # perturb config_hash and split the ablation table into incomparable groups.
    num_ctx: int = 8192
    """Context window requested from Ollama. Must exceed ``max_context_tokens`` plus the
    system prompt, the question and the answer, or the model silently truncates its own
    instructions -- see OllamaChat.num_ctx."""

    num_predict: int = 1024
    """Ceiling on generated tokens."""

    keep_alive: str = "30m"
    """How long Ollama keeps the model resident between questions."""

    preload: bool = True
    """Load the chat and embedding models at startup instead of on the first question."""

    chat_provider: Literal["ollama", "openai", "anthropic"] = "ollama"
    embed_provider: Literal["ollama", "openai"] = "ollama"

    @property
    def db_path(self) -> Path:
        return self.workspace / "clearrag.db"

    @property
    def vectors_path(self) -> Path:
        return self.workspace / "vectors.npy"

    def ensure_workspace(self) -> None:
        self.workspace.mkdir(parents=True, exist_ok=True)


def get_settings() -> Settings:
    return Settings()
