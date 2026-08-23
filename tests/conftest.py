from __future__ import annotations

import pytest

from clearrag.config import PipelineConfig, Settings
from clearrag.pipeline import Engine
from clearrag.providers.fake import FakeChat, FakeEmbeddings

CORPUS = {
    "resume.pdf": (
        "Henry Vendittelli is a software engineer.\n\n"
        "He studied computing at Queen's University in Kingston, Ontario, "
        "graduating with a degree in computer science.\n\n"
        "Previously he worked on distributed systems and developer tooling."
    ),
    "recipes.txt": (
        "Sourdough requires a mature starter and a long cold ferment.\n\n"
        "Bake at 250 degrees celsius with steam for the first fifteen minutes.\n\n"
        "The crumb structure depends heavily on hydration percentage."
    ),
}


@pytest.fixture
def settings(tmp_path) -> Settings:
    return Settings(workspace=tmp_path / "workspace")


@pytest.fixture
def config() -> PipelineConfig:
    # Small chunks so the tiny fixture corpus still produces several of them.
    return PipelineConfig(chunk_size=64, chunk_overlap=8, k_candidates=10, k_final=3)


@pytest.fixture
def chat() -> FakeChat:
    return FakeChat()


@pytest.fixture
def engine(settings, config, chat) -> Engine:
    return Engine(settings, config, chat=chat, embeddings=FakeEmbeddings())


@pytest.fixture
async def loaded_engine(engine) -> Engine:
    for filename, text in CORPUS.items():
        name = filename.replace(".pdf", ".txt")
        await engine.ingest(name, text.encode())
    return engine


async def drain(agen) -> list[dict]:
    return [event async for event in agen]
