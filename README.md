# clear-rag

A local-first RAG system whose retrieval process is **visible**.

Most RAG applications show you a spinner and then an answer. clear-rag streams the
machinery: you watch keyword search finish, vector search finish, the two rankings fuse,
and documents change position — and only then does the answer begin.

> Successor to [Local-RAG-System](https://github.com/hvenry/Local-RAG-System) (2024).
> That project answered "can I build a RAG pipeline?". This one asks "how well does it
> actually retrieve, and how would I know?"

---

## Why this exists

Two goals, in order.

**Learning by building.** The retrieval core is written from primitives — BM25 scoring
over a hand-built inverted index, reciprocal rank fusion, context assembly. Libraries are
used where they teach nothing (HTTP, SQLite, tensor math) and avoided where they would
hide the thing worth understanding.

**Measurement over features.** "I built a RAG pipeline" is not interesting; everyone has.
The artifact that matters is an ablation table showing each technique's measured effect on
retrieval quality. Phase 2 exists to produce it.

---

## Quick start

**Prerequisites:** Python 3.11+, [Ollama](https://ollama.com), Node 20+ (only to build the UI).

```bash
# 1. Pull the models (one chat model, one embedding model)
ollama pull llama3.2
ollama pull nomic-embed-text

# 2. Install
python3 -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"

# 3. Build the UI
cd web && npm install && npm run build && cd ..

# 4. Verify everything is reachable
clear-rag check

# 5. Run
clear-rag serve
```

Then drag a PDF, DOCX, Markdown, CSV or text file onto the window and ask a question.

### With Docker

Ollama runs on the **host**, not in a container — Docker on macOS has no GPU access, so a
containerised Ollama would be CPU-only and feel broken on the most common laptop.

```bash
docker compose up                    # app container → host Ollama
docker compose --profile ollama up   # app + containerised Ollama (Linux/CI)
```

### Bring your own key

Fully optional; the default path is local and needs no credentials.

```bash
cp .env.example .env
# then set CLEARRAG_CHAT_PROVIDER=anthropic and CLEARRAG_ANTHROPIC_API_KEY=...
pip install -e ".[byok]"
```

### Optional ML parser backends

The default parsers (`naive`, `primitives`) are dependency-light and always available.
The ML backends install as extras — they bring torch:

```bash
pip install -e ".[docling]"   # IBM docling (MIT): layout + TableFormer models
pip install -e ".[marker]"    # datalab marker (GPL-3.0; surya weights carry a
                              # commercial-use restriction above a revenue threshold)
```

marker's surya models additionally need an inference server: a GPU vllm container, or
a local `llama-server` binary (`LLAMA_CPP_BINARY=/path/to/llama-server` with
`SURYA_INFERENCE_BACKEND=llamacpp`). A configured backend that is not installed never
breaks ingestion — PDFs fall back to `naive` and the trace records the degradation.

---

## How it works

### Ingestion

```
Parse (backend) → Chunk (recursive | structural) → Contextualize → Embed → Index
```

Documents are content-hashed, so re-uploading an unchanged file costs nothing. Every
chunk records the **character span** it occupies in the source document — the invariant
that makes exact citation highlighting and span-anchored evaluation possible.

Parsing is a pluggable backend and a measured variable: `naive` (flat pypdf
extraction), `primitives` (a hand-rolled layout parser — columns, headings,
header/footer stripping, ruled and aligned tables — built from pdfplumber word
geometry), and `docling` / `marker` as optional ML extras. Every backend also emits
**typed blocks** (headings, paragraphs, tables) anchored to spans of the same text;
structural chunking cuts along them and contextual retrieval builds its breadcrumbs
from them. See *Phase 4 results* below for what each choice measurably does.

### Query

```
Rewrite → [ BM25 ∥ Vector ] → Fuse (RRF) → Rerank → Assemble → Generate
```

Keyword and vector search run concurrently. Fusion is Reciprocal Rank Fusion:

```
RRF(d) = Σ over retrievers  1 / (60 + rank(d))
```

RRF consumes *ranks*, not scores — BM25 scores are unbounded sums of idf terms and cosine
similarities live in [-1, 1], so they cannot be combined meaningfully without a
normalisation scheme that needs retuning whenever the corpus changes.

---

## The design decision everything rests on

Every retrieval stage consumes and produces the same type:

```python
@dataclass(frozen=True)
class Candidate:
    chunk_id: str
    score: float
    rank: int
    source: str  # "bm25" | "dense" | "rrf" | "rerank"
```

That single constraint is what makes the Retrieval Inspector generic. Because keyword
search, vector search, fusion and reranking all speak `list[Candidate]`, the UI draws a
rank-flow diagram between *any* two adjacent stages without knowing what those stages do.
A retrieval technique added later appears in the visualisation for free.

The trace is a **returned value, not a log** — `(answer, trace)` — so it also persists to
SQLite and can be replayed offline by the evaluation harness without re-invoking a model.

---

## Results

Measured on a 58-question golden set over a 10-document corpus (`evals/`), using
`nomic-embed-text` via Ollama. Reproduce with `clear-rag ablate`.

| Configuration | recall@1 | recall@5 | MRR | nDCG@5 | lexical | semantic | distractor |
|---|---|---|---|---|---|---|---|
| dense only, 50% overlap (2024 baseline) | 0.651 | 0.925 | 0.757 | 0.797 | 0.955 | 0.880 | 0.875 |
| dense only | 0.632 | 0.887 | 0.737 | 0.773 | 0.909 | 0.840 | 0.875 |
| keyword only (BM25) | 0.821 | 0.925 | 0.868 | 0.882 | 1.000 | 0.880 | 0.875 |
| hybrid + weighted fusion | 0.858 | 1.000 | 0.922 | 0.942 | 1.000 | 1.000 | 1.000 |
| hybrid + RRF | 0.783 | 1.000 | 0.884 | 0.913 | 1.000 | 1.000 | 1.000 |
| **hybrid + RRF + cross-encoder rerank** | **0.972** | 1.000 | **0.991** | 0.993 | 1.000 | 1.000 | 1.000 |
| hybrid + RRF, 96-token chunks | 0.764 | 0.962 | 0.858 | 0.931 | 1.000 | 0.960 | 0.875 |
| hybrid + RRF, 192-token chunks | 0.802 | 0.981 | 0.887 | 0.980 | 1.000 | 1.000 | 0.875 |
| hybrid + RRF, 256-token chunks | 0.802 | 0.981 | 0.877 | 0.912 | 1.000 | 1.000 | 0.875 |
| hybrid + RRF, 1024-token chunks | 0.764 | 1.000 | 0.868 | 0.901 | 1.000 | 1.000 | 1.000 |

`lexical` / `semantic` / `distractor` are recall@5 restricted to question sets tagged
that way. Distractor questions are ones with a plausible near-miss elsewhere in the
corpus — production access is described in both `security.md` and `onboarding.md` with
different answers, and "retention" means thirteen months in one document and thirty-five
days in another.

**What the numbers say.** Two techniques carry the table. Hybrid retrieval: dense alone
reaches 0.887 recall@5 and BM25 alone 0.925, while combining them reaches 1.000 and
resolves every distractor question either method alone got wrong. Then reranking — a
23 MB quantised cross-encoder (ms-marco-MiniLM via ONNX, downloaded on first use, no
torch) re-scores the fused shortlist and delivers the single largest jump measured:
recall@1 0.783 → **0.972**, MRR 0.884 → **0.991**, for a few hundred milliseconds per
query. Fusion gets the right chunk into the top five; the reranker puts it first. Notably **BM25 beats vector
search here** — on a technical corpus full of exact identifiers (`422`, `hb bootstrap`,
`X-RateLimit-Remaining`) lexical matching is genuinely strong, which is the argument
against the dense-only pipeline this project's predecessor used.

**Three honest caveats**, because a table without them is a sales pitch:

1. **recall@5 saturates.** At 1.000 it can no longer distinguish the top three rows —
   recall@1 and MRR are doing the discriminating. A larger corpus would fix this; the
   current one is 22 KB.
2. **Weighted fusion beating RRF is not a finding.** The gap at recall@1 (0.858 vs 0.783)
   is four questions out of 53, well inside noise for a set this size. RRF stays the
   default because rank-based fusion needs no per-corpus score normalisation, not because
   this table endorses it.
3. **The chunk-size rows barely move, and that is itself a finding.** Every size from
   96 to 1024 tokens lands within a few questions of the others. Retrieval is not
   sensitive to chunk size on prose where each document covers a distinct topic — the
   right document gets found either way. See *What this benchmark cannot see* below for
   where that stops being true.
4. **The overlap row proves nothing.** These documents are short enough to fit in roughly
   one 512-token chunk, so 50% and 12% overlap produce the same 11 chunks and the same
   scores. On a document long enough for overlap to apply, 50% produces 19 chunks against
   10 and duplicates 51% of the indexed text — that is a real index-size cost, it just
   is not visible here.

### What this benchmark cannot see

Retrieval metrics only measure whether the right text was *retrieved*. They are blind to
whether the model then attributed a claim to the right part of it — and that turns out to
be where a real failure lives.

Indexing a one-page résumé (4.5 KB) produces three chunks at the default 512-token size.
With `k_final=5`, **every query retrieves the entire document**, so recall is trivially
perfect and the ablation table above would rate the configuration flawless. Asked *"What
did Henry do at QMIND?"*, the answer was still wrong: QMIND sat at character 2897 inside a
2,092-character chunk that also held a data-science role, an education entry, and two other
clubs, and a 3B model could not pick it out.

Same question, same model, same document — only chunk size differs:

| chunk_size | chunks | Answer |
|---|---|---|
| 512 | 3 | *"I don't have that information in the provided documents."* |
| 192 | 6 | *"[2] states that Henry created an NLP program trained on a dataset of Reddit comments mapping to 1 of 27 emotions."* ✓ |

Reranking would have changed nothing here: with three chunks and `k_final=5`, there is
nothing to reorder. Larger chunks are not a retrieval problem, they are an *attribution*
problem, and catching that class of defect needs the answer-side metrics
(`clear-rag eval --generate`) rather than recall@k.

The lesson generalises past this project: a benchmark that only scores retrieval will
report a healthy system while users get wrong answers.

### Measuring what retrieval metrics cannot see

The section above ends with a warning: a benchmark that only scores retrieval reports a
healthy system while users get wrong answers. This suite closes that gap. It runs with
`--generate` and grades the **answers**, deterministically — no judge model:

| Metric | Question it answers |
|---|---|
| false refusals | did the model say "I don't know" with the answer in front of it? |
| required mentions / wrong-section bleed | is the right content present — and content from the *wrong* section absent? (`must_not_mention` labels) |
| grounding / citation precision | do the cited chunks actually cover the labelled answer span? |

The attribution suite (`evals/attribution/`) is a single fictional staff profile whose
sections deliberately share vocabulary — a day job doing forecasting, an AI club doing
NLP, projects that echo both. One document means retrieval is trivially perfect in every
configuration, so **every failure the suite reports is a generation failure.**

Measured on the bundled suite (12 answerable + 3 unanswerable questions):

| Model · chunk size | retrieval recall@5 | required mentions | grounding | citation precision |
|---|---|---|---|---|
| qwen3.5:9b · 512 | 1.000 | **1.000** | **1.000** | **1.000** |
| qwen3.5:9b · 192 | 1.000 | **1.000** | **1.000** | 0.917 |
| llama3.2:3b · 512 | 1.000 | 0.917 | **0.417** | 0.417 |
| llama3.2:3b · 192 | 1.000 | 0.750 | **0.583** | 0.583 |

Reading it: retrieval metrics are a flat, useless 1.000 across every row — and grounding
varies by a factor of 2.4. The 3B model usually *says* the right thing (mentions ≈ 0.9)
while citing the wrong chunk more than half the time; smaller chunks help it somewhat
(0.417 → 0.583) but don't fix it. The 9B model is essentially perfect at either chunk
size. This settles, with numbers, what an earlier debugging session found anecdotally on
a real résumé: past a modest floor, **attribution quality is a property of the model far
more than of the chunking** — and it is entirely invisible to recall@k.

```bash
clear-rag eval --suite attribution --generate            # current model
CLEARRAG_CHAT_MODEL=llama3.2 clear-rag eval --suite attribution --generate --chunk-size 192
```

### The regression gate

`pytest` runs the same golden set through the real pipeline on **fake providers** and
compares against `evals/baseline.json`. The fake embedder is a bag-of-words hash
projection, so those scores measure nothing about quality — but they are deterministic,
need no models, and catch a change that silently breaks chunking, BM25, fusion or
assembly. Real quality numbers come from `clear-rag ablate` against Ollama.

Making that gate trustworthy required a fix worth mentioning: chunk ids were originally
random UUIDs, and because BM25 and RRF break score ties on chunk id, two runs over an
identical corpus produced different metrics. Ids are now derived from document and
position, so runs are byte-for-byte reproducible and traces from separate runs are
directly comparable.

```bash
clear-rag eval                    # score the golden set with real models
clear-rag eval --suite sec        # the 10-K corpus: parsing/chunking/context measurable
clear-rag parse-quality           # differential-test parser backends vs HTML ground truth
clear-rag eval --generate         # also generate answers: refusal + required-mention accuracy
clear-rag ablate                  # sweep configurations, print the table above
clear-rag ablate --fake           # deterministic, no models needed
python scripts/refresh_baseline.py  # after a deliberate retrieval change
```

### How the golden set works

Relevance is anchored to **character spans in source documents**, never to chunk ids.
Chunk ids change whenever chunking configuration changes — and comparing chunking
strategies is the point — so id-anchored labels would invalidate themselves the first
time they were useful.

Labels are written as quotes and resolved to spans at load time, with whitespace matched
flexibly so a label can span a Markdown line wrap. A quote that matches nothing, or
matches twice, is a hard error:

```json
{"id": "q_canary", "question": "What percentage of traffic does a canary receive?",
 "relevant": [{"doc": "deployment.md", "quote": "five percent of traffic is routed to the new build"}],
 "must_mention": ["five percent"], "tags": ["lexical"]}
```

recall@k counts **labelled spans covered**, not relevant chunks retrieved. The obvious
denominator moves when you change chunk size — the same passage becomes one chunk or
four — so the score would shift without retrieval having changed at all.

---

## Phase 4 results: parsing, structural chunking, contextual retrieval

Phase 4 made three more stages measurable, on a new benchmark built for the purpose:
curated sections of two real SEC 10-K filings (Apple and Microsoft FY2023) as rendered
PDFs, with tag-stripped text from the same filings' HTML kept as **parse ground truth**
— so parser backends are differentially tested (`clear-rag parse-quality`) the same way
BM25 is tested against FTS5. A 42-question golden set tags `table`, `structure` and
`cross-company` questions; `clear-rag ablate --suite sec` sweeps parser × chunker ×
context with real models.

| Configuration | recall@1 | recall@5 | table | cross-company |
|---|---|---|---|---|
| naive parser (pypdf) | 0.564 | 0.872 | 0.636 | 0.889 |
| primitives parser | 0.462 | 0.846 | 0.545 | 0.778 |
| docling parser | 0.385 | 0.718 | 0.455 | 0.667 |
| primitives + semantic chunking | 0.487 | 0.769 | **0.273** | 0.778 |
| primitives + breadcrumb context | 0.462 | 0.846 | 0.545 | 0.778 |
| primitives + LLM context | 0.436 | 0.846 | 0.545 | 0.778 |

Three findings, none of them the marketing version (full tables and caveats in
[`evals/sec/README.md`](evals/sec/README.md)):

1. **Flat extraction wins on born-digital PDFs — and the hand-rolled parser beats the
   ML one.** These Chromium-rendered filings are pypdf's best case, and the ~400-line
   geometric parser (`primitives`) outscores docling's layout models on both parse
   fidelity (word recovery 0.996 vs 0.989) and retrieval, while docling's aggressive
   table reconstruction loses two labelled answers outright. Structure's value flows to
   the stages that consume it (structural chunking, breadcrumbs, the Library's
   structure view), not to raw retrieval on clean renders. The differential test also
   caught two real parser bugs during development — a page-wide phantom grid built
   from 186 table-shading rects, and part-page column bands interleaving side-by-side
   lines — worth 0.78 → 0.99 in reading-order fidelity.
2. **Semantic chunking regresses financial tables** (table recall 0.545 → 0.273):
   heading-bounded packing folds a statement's table into one large mixed chunk that
   ranks worse than the accidental isolation fixed-size cutting provides. The block
   model points at its own fix — atomic table chunks — and the metric to judge it is
   already in place.
3. **Contextual retrieval measured a null** on this corpus: identical recall under no
   context, breadcrumbs, and LLM-written context. Two companies with distinct
   vocabulary give the technique nothing to disambiguate; its motivating case is many
   near-identical documents. The free breadcrumb is the default; the LLM mode (cached
   by content hash so re-indexing is free) stays a knob.

`marker` is wired as a fourth backend (optional extra; note its GPL-3.0 licence and
surya model-weight restrictions) and passes its contract test, but its ablation row is
pending — surya inference needs a GPU path or a local `llama-server`, and the CPU run
was impractically slow.

---

## Interface

Three views. **Chat** streams each retrieval stage as it completes, then the answer.
**Library** shows how a document was split — chunk boundaries drawn over the source
text, overlap regions shaded darker, and a *structure* view of the typed blocks the
parser recovered (headings sized by level, tables boxed), which is what structural
chunking cuts along. Pin a chunk and the readout shows the contextual-retrieval
preamble it was indexed under. **Lab** turns every pipeline knob into a control:
change one setting, ask the same question again, and the runs sit side by side with the
changed setting highlighted — hybrid vs vector-only, chunk size 512 vs 192, recursive
vs semantic chunking, parser backend, contextual retrieval on or off. Settings that
rewrite the index trigger an explicit re-index, rebuilt from stored text without
needing the original files (a parser change is called out as the one exception —
re-indexing cannot re-parse, so it applies to files uploaded afterwards). Knobs that
exist in the config but are not implemented yet (HyDE, multi-query, self-correction)
appear disabled with a note, so the interface never pretends.

A one-click **sample corpus** (the evaluation documents — 10 files, ~60 chunks at small
chunk sizes) exists because a three-chunk résumé makes every comparison degenerate:
below ~20 chunks each search returns everything and no setting visibly matters.

Every stage, metric and column explains itself on hover — "Fuse (RRF)" means nothing
until something tells you it merges two rankings so a chunk both searches liked beats one
that only a single search ranked first. The interface should not require the README.

### The retrieval inspector

A per-chunk table is the primary view, not a chart. A chart only communicates when there
is movement to see: index a one-page résumé and every retriever returns all three chunks,
so a bump chart draws three flat lines and says nothing. The table still reports exactly
what happened, and stays readable at fifty candidates where a chart becomes spaghetti.
The rank-flow chart appears above five candidates, where crossing lines earn their space.

### Colour policy

Monochrome carries the interface; colour carries only data, and only two jobs:

| Job | Encoding |
|---|---|
| Which search found a chunk | blue = vector, aqua = keyword, ink = both |
| A stage slow enough to notice | amber ≥ 1s, red ≥ 5s — **fast is deliberately uncoloured** |

Colour marks the exception, not the rule. In a typical query exactly one number is
coloured — generation — and it is the one worth looking at.

The palette was validated with a CVD/contrast checker against this project's actual
surfaces (pure `#000` and pure `#fff`, not a generic near-black), all pairs, both modes.
Two findings changed the design:

- A green/amber/red latency scale **failed** at CVD ΔE 3.0 under protanopia — the
  traffic-light problem. Dropping green entirely fixed it and improved the design.
- Orange-for-keyword collided with amber-for-slow, so keyword moved to aqua.

Two warnings remain and are discharged by construction: dark red↔aqua sits in the 6–8 ΔE
band and light aqua is 2.82:1, both legal only with secondary encoding — so every
coloured mark ships a visible text label and nothing is ever encoded in colour alone.

---

## Correctness, deliberately

Three decisions that invert what a RAG tutorial would tell you:

**The vector index is exact, not approximate.** Under ~100k chunks, exhaustive cosine is
single-digit milliseconds and has no parameters to misconfigure. Swapping in FAISS HNSW is
deferred to Phase 5 specifically so that it arrives as a *measured* experiment — recall@k
against latency, plotted — rather than an unexamined day-one default.

**BM25 is differentially tested.** A from-scratch ranking function is easy to write
plausibly and hard to verify by reading. `tests/test_bm25.py` indexes the same corpus into
SQLite's FTS5 and asserts both implementations agree.

**Changing the embedding model refuses to serve.** Vectors written by a different model
are not comparable. The embedder identity is stored beside the index; a mismatch stops
queries and asks for a re-index instead of quietly returning noise.

---

## What the predecessor got wrong

Building this made three real bugs in the 2024 project legible. They are called out in
code comments where the fix lives, and two have regression tests:

| Bug | Consequence | Fixed in |
|---|---|---|
| The history-aware retriever's prompt said *"provide a response…"* — but its output is fed straight into the retriever as a **search query**, with no documents available yet | From turn two onward, the index was searched with a hallucinated answer | `generate/prompt.py:REWRITE_SYSTEM`, tested in `test_followup_is_rewritten_not_answered` |
| Document vectors were normalised by hand; query vectors were not | Reported similarity scores were meaningless (ranking survived by luck) | `providers/base.py:l2_normalise` |
| Answer quality was scored as cosine similarity to its own context | Rewarded verbatim copying, and **penalised a correct "I don't know"** | Refusal is recorded as correct behaviour, tested in `test_refusal_is_recorded_as_such` |

Plus: the index was rebuilt from scratch on every launch (`save_local` was called,
`load_local` never was), and chunk overlap was 50%, which doubled the index and filled
top-k with near-duplicates of one passage.

---

## Development

```bash
pytest                       # full suite incl. regression gate, no models required
ruff check . && ruff format .
mypy src

make dev                     # backend (auto-reload) + frontend (HMR), open :5173
```

`make dev` runs both halves of the development loop in one command: uvicorn with
`--reload` for Python changes and Vite with hot-module-replacement for the UI,
proxying `/api` to the backend. One Ctrl-C stops both. `make serve` is the other mode —
a single server with the *built* UI, which is what production and Docker run.

Before starting either half, `make dev` checks the things whose failure is otherwise
invisible: that the virtualenv exists and still matches `pyproject.toml` (a dependency
added after the venv was built does not crash — it silently degrades), that the port is
free, and that Ollama is answering. It then waits for the backend to serve a real request
before handing the terminal to Vite. This ordering is the whole point: Vite prints a
ready banner and proxies `/api` whether or not the backend came up, so a backend that
died at boot presents as a broken app rather than a missing process — and if something
else owns the port, as *someone else's* 404s.

**The port lives in one place.** `CLEARRAG_PORT` (default `8010`) is read by
`Settings.port`, by the Vite dev proxy, and by `docker-compose.yml`. Change it in `.env`
and every consumer follows. It deliberately avoids 8000, which is the default for Django,
`http.server`, and half the containers on a working laptop — a collision there answers
with a plausible-looking 404 instead of refusing the connection.

Tests run entirely on **fake providers** — a deterministic bag-of-words hash embedder and
a scripted chat model. That is the one piece of infrastructure that makes a RAG project
testable; without it every path appears to need a running model, which is why most RAG
repositories have no tests at all. The fake embedder is not random, so retrieval tests
assert real ranking behaviour rather than merely that the plumbing connects.

---

## Roadmap

| Phase | Scope | Status |
|---|---|---|
| **0** | Stage/Trace machinery, Ollama providers, ingest → index, BM25 + vector + RRF, SSE API, chat UI + Retrieval Inspector + Chunk Inspector, Docker | ✅ done |
| **1** | Golden set, recall@k / MRR / nDCG, ablation runner, CI regression gate | ✅ done |
| **2** | Lab: live config, side-by-side comparison, re-index from stored text | ✅ done |
| **3** | Cross-encoder reranking (ONNX), embedding map, Learn section | ✅ done |
| **3.5** | Answer-side evaluation: attribution suite, grounding & refusal metrics | ✅ done |
| **4** | Pluggable parser backends (hand-rolled `primitives` + docling/marker extras), SEC 10-K benchmark with differential parse testing, structural chunking, contextual retrieval | ✅ done |
| **5** | HyDE, multi-query, decomposition, self-correction | |
| **6** | Approximate index as a measured experiment; Electron packaging | |

Evaluation moved ahead of reranking on purpose: build the ruler before the thing you
want to measure, so every subsequent change arrives with a before-and-after number
rather than a claim.

