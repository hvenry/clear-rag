# Providers

Providers are the swappable model backends: a chat model, an embedding model and an optional cross-encoder reranker.

## Why
Generation, embedding and reranking are independent choices, so it is reasonable to generate with Claude while embedding locally with Ollama.
Keeping them behind protocols means adding a backend is one file plus one registry branch, with no pipeline change.
Deterministic fake providers are what make the whole pipeline testable without a running model.

## How it works
`src/clearrag/providers/base.py` defines three protocols:
- `ChatProvider` - `complete`, `stream` and `healthcheck`.
- `EmbeddingProvider` - `embed(texts, kind=...)`, `dimensions` and an `id` that names the embedding space (for example `ollama:nomic-embed-text`).
- `Reranker` - `rerank(query, candidates, texts, top_k)` returning re-ranked `Candidate`s.
Failures raise `ProviderError`, which carries a human-readable `remedy` that the API and UI show instead of a stack trace.

`src/clearrag/providers/registry.py` builds providers from [Settings](configuration.md):
- `build_chat` switches on `chat_provider` (`ollama`, `openai`, `anthropic`).
- `build_embeddings` switches on `embed_provider` (`ollama`, `openai`) and accepts a model override, which is how an ablation row measures another embedder.
- `build_reranker` returns `None` when `onnxruntime` or `tokenizers` is missing, and the rerank stage then reports itself as unavailable.
- `available_embedders` asks Ollama which candidate embedding models are pulled, so a sweep skips the rest instead of failing on a 404.

**Ollama** (`ollama.py`) is the default and needs no credentials.
It serves both chat and embeddings, which keeps torch out of the default install.
Asymmetric embedding prefixes (query vs document) live in one `_PREFIXES` table keyed by model name.
Chat requests send `think`, `num_ctx`, `num_predict` and `keep_alive` explicitly; `preload` warms both models at server start.

**OpenAI-compatible** (`openai.py`) uses raw httpx against `openai_base_url`, so any compatible endpoint works without the SDK.

**Anthropic** (`anthropic.py`) imports the `anthropic` SDK lazily.
It sends no `temperature`, mapping it onto an `effort` level instead, lifts system messages to the top-level parameter, and enables server-side refusal fallbacks.
A non-Claude `chat_model` falls back to the module's `DEFAULT_MODEL`.

**Reranker** (`rerank_onnx.py`) is ms-marco-MiniLM-L-6-v2, quantised int8 ONNX.
It downloads `model.onnx` and `tokenizer.json` into `workspace/models/ms-marco-minilm-l6` on the first reranked query, atomically per file.
Scores are the sigmoid of the logit, and `detail` keeps the raw logit and the previous rank.

**Fakes** (`fake.py`) back every test and `--fake` runs.
`FakeEmbeddings` is a bag-of-words hash projection, so texts sharing vocabulary really do land near each other and tests assert real ranking behaviour.
It accepts any model name, so a sweep can name several fake embedders and get distinct indexes.
`FakeChat` replays a scripted list of replies, then answers with a fixed cited sentence, and records every call for assertions.

**Runtime switching and readout.**
`PUT /api/providers` accepts only `chat_model` and `embed_model`, updates the in-memory settings and drops the engine so the next request rebuilds it.
The response sets `reindex_needed` when the embedding model changed.
`GET /api/models` lists pulled Ollama models split into chat and embedding by their reported capabilities.
`src/clearrag/providers/runtime.py` reads Ollama's `/api/ps` for `GET /api/runtime`: resident models, VRAM share and loaded context length, to expose CPU spill and context-size reloads.

## Tech
- httpx for Ollama and OpenAI-compatible APIs, the `anthropic` SDK for Claude.
- onnxruntime and tokenizers for the reranker, numpy for vectors.

## Key files
- `src/clearrag/providers/base.py` - protocols, `ProviderError`, `l2_normalise`.
- `src/clearrag/providers/registry.py` - builds providers from settings.
- `src/clearrag/providers/ollama.py` - default chat and embeddings, prefixes, model pull.
- `src/clearrag/providers/openai.py` - OpenAI-compatible chat and embeddings.
- `src/clearrag/providers/anthropic.py` - Claude chat.
- `src/clearrag/providers/rerank_onnx.py` - cross-encoder reranker.
- `src/clearrag/providers/fake.py` - deterministic test providers.
- `src/clearrag/providers/runtime.py` - Ollama runtime readout.

## Decisions and gotchas
- `embed(..., kind=...)` is mandatory, so a query can never be encoded as a document; the predecessor made exactly that mistake.
- `l2_normalise` normalises both queries and documents, so inner product equals cosine; the predecessor normalised only documents, which made its scores meaningless.
- `think` defaults off because a reasoning model spent its whole output budget thinking and returned no answer.
- `num_ctx` is sent explicitly because Ollama's usual default equals the context budget and silently truncates the instructions.
- The fake embedder ignores `kind` on purpose, so tests are not sensitive to prefixes.
- Changing the embedder invalidates the index; see [indexes](indexes.md) for the guard.
- No `pyproject.toml` extra installs the `anthropic` SDK; install it manually to use that provider.

## Related
- [Configuration](configuration.md)
- [Query pipeline](query-pipeline.md)
- [Indexes](indexes.md)
- [Testing](testing.md)
- [API](api.md)
