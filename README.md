# clear-rag

A local-first RAG system whose retrieval process is **visible**.

Most RAG applications show you a spinner and then an answer.
clear-rag streams the machinery: you watch keyword search finish, vector search finish, the two rankings fuse, and documents change position, and only then does the answer begin.

> Successor to [Local-RAG-System](https://github.com/hvenry/Local-RAG-System) (2024).
> That project answered "can I build a RAG pipeline?".
> This one asks "how well does it actually retrieve, and how would I know?"

---

## Why this exists

Two goals, in order.

**Learning by building.**
The retrieval core is written from primitives: BM25 scoring over a hand-built inverted index, reciprocal rank fusion, context assembly.
Libraries are used where they teach nothing (HTTP, SQLite, tensor math) and avoided where they would hide the thing worth understanding.

**Measurement over features.**
"I built a RAG pipeline" is not interesting; everyone has.
The artifact that matters is an ablation table showing each technique's measured effect on retrieval quality.

---

## Quick start

**Prerequisites:** Python 3.11+ (the Makefile and CI use 3.12), [Ollama](https://ollama.com), Node 20+ (only to build the UI; CI uses 22).

```bash
# 1. Pull the models (one chat model, one embedding model)
ollama pull llama3.2
ollama pull nomic-embed-text

# 2. Install Python and web dependencies into .venv and web/node_modules
make install

# 3. Build the UI
make build

# 4. Verify everything is reachable
make check

# 5. Run: one server with the built UI on http://localhost:8010
make serve
```

Then drag a PDF, DOCX, Markdown, CSV or text file onto the window and ask a question, or load the bundled sample corpus from the Library.

### With Docker

Ollama runs on the **host**, not in a container, because Docker on macOS has no GPU access.
A containerised Ollama would be CPU-only and feel broken on the most common laptop.

```bash
docker compose up                    # app container -> host Ollama
docker compose --profile ollama up   # app + containerised Ollama (Linux/CI)
```

With the `ollama` profile, set `CLEARRAG_OLLAMA_URL=http://ollama:11434` so the app talks to the container instead of the host.

### Bring your own key

Fully optional; the default path is local and needs no credentials.

```bash
cp .env.example .env
# OpenAI (chat or embeddings): set CLEARRAG_CHAT_PROVIDER=openai and CLEARRAG_OPENAI_API_KEY=...
# Anthropic (chat only):       set CLEARRAG_CHAT_PROVIDER=anthropic and CLEARRAG_ANTHROPIC_API_KEY=...
.venv/bin/pip install anthropic   # only the Anthropic provider needs an extra package
```

The OpenAI provider speaks raw HTTP and needs nothing beyond the base install.

### Optional ML parser backends

The default parsers (`naive`, `primitives`) are dependency-light and always available.
The ML backends install as extras, since they bring torch:

```bash
pip install -e ".[docling]"   # IBM docling (MIT): layout + TableFormer models
pip install -e ".[marker]"    # datalab marker (GPL-3.0; surya weights carry a
                              # commercial-use restriction above a revenue threshold)
```

marker's surya models additionally need an inference server: a GPU vllm container, or a local `llama-server` binary (`LLAMA_CPP_BINARY=/path/to/llama-server` with `SURYA_INFERENCE_BACKEND=llamacpp`).
A configured backend that is not installed never breaks ingestion: PDFs fall back to `naive` and the trace records the degradation.

---

## How it works

### Ingestion

```
Parse (backend) -> Chunk (recursive | semantic) -> Contextualize -> Embed -> Index
```

Documents are content-hashed, so re-uploading an unchanged file costs nothing.
Every chunk records the **character span** it occupies in the source document, the invariant that makes exact citation highlighting and span-anchored evaluation possible.

Parsing is a pluggable backend and a measured variable: `naive` (flat pypdf extraction), `primitives` (a hand-rolled layout parser built from pdfplumber word geometry), and `docling` / `marker` as optional ML extras.
Every backend also emits **typed blocks** (headings, paragraphs, tables) anchored to spans of the same text; structural chunking cuts along them and contextual retrieval builds its breadcrumbs from them.
Details: [docs/ingestion.md](docs/ingestion.md).

### Query

```
Rewrite -> Expand? -> [ BM25 || Vector ] -> Fuse (RRF) -> Rerank -> Assemble -> Generate
```

Keyword and vector search run concurrently.
Fusion is Reciprocal Rank Fusion:

```
RRF(d) = sum over retrievers  1 / (60 + rank(d))
```

RRF consumes *ranks*, not scores.
BM25 scores are unbounded sums of idf terms and cosine similarities live in [-1, 1], so they cannot be combined meaningfully without a normalisation scheme that needs retuning whenever the corpus changes.

**Multi-query expansion** (`query_transform=multi`) has the chat model write a few alternative phrasings of the question and searches every one of them.
Each retriever fuses its own rankings across the phrasings *before* the two retrievers are fused, so the inspector can still say which search found a chunk.
It exists for questions whose wording diverges from the document's ("can a customer be relocated to a different data centre?" against a page that says *moving a tenant between regions*), and the golden set tags those `paraphrase`.
Details: [docs/query-pipeline.md](docs/query-pipeline.md).

---

## The design decision everything rests on

Every retrieval stage consumes and produces the same type:

```python
@dataclass(frozen=True)
class Candidate:
    chunk_id: str
    score: float
    rank: int
    source: str
    detail: dict[str, Any]
```

That single constraint is what makes the Retrieval Inspector generic.
Because keyword search, vector search, fusion and reranking all speak `list[Candidate]`, the UI draws a rank-flow diagram between *any* two adjacent stages without knowing what those stages do.
A retrieval technique added later appears in the visualisation for free.

The trace is a **returned value, not a log**, so it also persists to SQLite and can be replayed offline by the evaluation harness without re-invoking a model.

---

## Results

Measured on a 67-question golden set (62 answerable, 5 unanswerable) over a 10-document corpus (`evals/`), using `nomic-embed-text` via Ollama, with `qwen3.5:9b` writing the phrasings for the multi-query rows.
The whole sweep was re-measured on 2026-09-09 after nine `paraphrase` questions joined the set; every row moved a little, because the new questions are the hard ones.
The embedding model is a dimension of the sweep too: `clear-rag ablate` adds a dense-only and a hybrid + RRF row for each of `all-minilm` and `mxbai-embed-large` that Ollama has pulled (or any model named with `--embedder`), each on its own index.
The table is rendered from `evals/results/retrieval.json`, the same file the app's **Results** view reads, so the README, the interface and the file cannot disagree.

<!-- results:retrieval -->
| Configuration | recall@1 | recall@5 | MRR | nDCG@5 | lexical | semantic | distractor | paraphrase |
|---|---|---|---|---|---|---|---|---|
| dense only, 50% overlap (2024 baseline) | 0.589 | 0.903 | 0.708 | 0.765 | 0.955 | 0.880 | 0.875 | 0.778 |
| dense only | 0.573 | 0.871 | 0.691 | 0.745 | 0.909 | 0.840 | 0.875 | 0.778 |
| keyword only (BM25) | 0.766 | 0.903 | 0.823 | 0.843 | 1.000 | 0.880 | 0.875 | 0.778 |
| hybrid + weighted fusion | 0.782 | 0.968 | 0.866 | 0.900 | 1.000 | 1.000 | 1.000 | 0.778 |
| hybrid + RRF | 0.734 | 0.968 | 0.841 | 0.874 | 1.000 | 1.000 | 1.000 | 0.778 |
| hybrid + RRF + multi-query | 0.653 | 0.984 | 0.802 | 0.854 | 0.955 | 1.000 | 1.000 | 1.000 |
| **hybrid + RRF + cross-encoder rerank** | 0.927 | 1.000 | 0.965 | 0.974 | 1.000 | 1.000 | 1.000 | 1.000 |
| **hybrid + RRF + rerank + multi-query** | 0.927 | 1.000 | 0.965 | 0.974 | 1.000 | 1.000 | 1.000 | 1.000 |
| hybrid + RRF, 96-token chunks | 0.702 | 0.887 | 0.789 | 0.855 | 1.000 | 0.960 | 0.875 | 0.444 |
| hybrid + RRF + multi-query, 96-token chunks | 0.540 | 0.750 | 0.636 | 0.673 | 0.864 | 0.720 | 0.875 | 0.556 |
| hybrid + RRF, 192-token chunks | 0.750 | 0.919 | 0.826 | 0.908 | 1.000 | 1.000 | 0.875 | 0.556 |
| hybrid + RRF, 256-token chunks | 0.734 | 0.952 | 0.823 | 0.862 | 1.000 | 1.000 | 0.875 | 0.778 |
| hybrid + RRF, 1024-token chunks | 0.718 | 0.968 | 0.828 | 0.864 | 1.000 | 1.000 | 1.000 | 0.778 |
| dense only, all-minilm | 0.621 | 0.911 | 0.754 | 0.800 | 0.818 | 0.960 | 0.875 | 1.000 |
| hybrid + RRF, all-minilm | 0.734 | 1.000 | 0.841 | 0.878 | 1.000 | 1.000 | 1.000 | 1.000 |
| dense only, mxbai-embed-large | 0.605 | 0.984 | 0.756 | 0.823 | 1.000 | 1.000 | 1.000 | 0.889 |
| hybrid + RRF, mxbai-embed-large | 0.798 | 0.968 | 0.872 | 0.896 | 1.000 | 1.000 | 1.000 | 0.778 |
<!-- /results:retrieval -->

`lexical` / `semantic` / `distractor` are recall@5 restricted to question sets tagged that way.
Distractor questions have a plausible near-miss elsewhere in the corpus: production access is described in both `security.md` and `onboarding.md` with different answers, and "retention" means thirteen months in one document and thirty-five days in another.
`paraphrase` questions are worded to share almost no vocabulary with the passage that answers them, which is the failure query expansion exists to fix.

**What the numbers say.**
Two techniques carry the table.
Hybrid retrieval: dense alone reaches 0.871 recall@5 and BM25 alone 0.903, while combining them reaches 0.968 and resolves every distractor question either method alone got wrong.
Then reranking.
A 23 MB quantised cross-encoder (ms-marco-MiniLM via ONNX, downloaded on first use, no torch) re-scores the fused shortlist and delivers the single largest jump measured: recall@1 0.734 -> **0.927**, MRR 0.841 -> **0.965**, and the two paraphrase questions fusion missed outright land at ranks one and three, for a few hundred milliseconds per query.
Fusion gets the right chunk into the top five; the reranker puts it first.
Notably **BM25 beats vector search here**: on a technical corpus full of exact identifiers (`422`, `hb bootstrap`, `X-RateLimit-Remaining`) lexical matching is genuinely strong, which is the argument against the dense-only pipeline this project's predecessor used.

**The embedder rows.**
On this corpus the small 384-dimension `all-minilm` matches `nomic-embed-text` (dense-only recall@1 0.621 against 0.573), and hybrid fusion flattens the gap between embedders: hybrid + RRF lands at 0.734 recall@1 with either, and 0.798 with `mxbai-embed-large`.
Keyword search carries enough of the ranking that the choice of embedder matters less than it would in a dense-only pipeline.

**Four honest caveats**, because a table without them is a sales pitch:

1. **recall@5 nearly saturates.**
   The reranked rows sit at 1.000 and the hybrid rows at 0.968, so the column can barely separate them; recall@1 and MRR are doing the discriminating.
   A larger corpus would fix this; the current one is 22 KB.
2. **Weighted fusion beating RRF is not a finding.**
   The gap at recall@1 (0.782 vs 0.734) is three questions out of 62 answerable, well inside noise for a set this size.
   RRF stays the default because rank-based fusion needs no per-corpus score normalisation, not because this table endorses it.
3. **The chunk-size rows barely move, with one exception the new questions expose.**
   From 192 to 1024 tokens every size lands within a few questions of the others: retrieval is not sensitive to chunk size on prose where each document covers a distinct topic.
   At 96 tokens the `paraphrase` column falls to 0.444, because a chunk that small carries too little of the surrounding wording for a differently-phrased question to land on it.
   See *What this benchmark cannot see* below for the other place chunk size matters.
4. **The overlap row proves nothing.**
   These documents are short enough to fit in roughly one 512-token chunk, so 50% and 12% overlap produce the same 11 chunks and the same scores.
   On a document long enough for overlap to apply, 50% produces 19 chunks against 10 and duplicates 51% of the indexed text.
   That is a real index-size cost; it just is not visible here.

**Multi-query expansion: measured, and honest about it.**
On the nine `paraphrase` questions the technique does its job: on hybrid + RRF it lifts the `paraphrase` column from 0.778 to **1.000**, recovering both questions fusion had missed outright.
It also has a bill.
recall@1 falls 0.734 -> 0.653 and MRR 0.841 -> 0.802, because the extra phrasings pull in near-misses that reciprocal rank across phrasings then promotes over the exact hit: the first relevant chunk moved up on ten questions and down on fourteen.
At 96-token chunks the same trade turns bad: `paraphrase` rises 0.444 -> 0.556 while every other column drops.
Stacked on the reranker it changes nothing at all, for a structural reason: at 512 tokens this corpus is eleven chunks and each search returns fifty candidates, so the shortlist *is* the corpus and the cross-encoder alone decides the order.
Expansion can only change what enters the shortlist, and here nothing is ever left out.
The reranker reaches the same 1.000 with a better recall@1 for about 0.5 s per question, against 3.7 s of `qwen3.5:9b` writing phrasings.
So the knob stays, off by default, and the case it was built for (a corpus large enough that the shortlist is a real cut) is one this benchmark cannot yet make.
A recall lever with a precision bill; here the reranker is the better buy.

### What this benchmark cannot see

Retrieval metrics only measure whether the right text was *retrieved*.
They are blind to whether the model then attributed a claim to the right part of it, and that turns out to be where a real failure lives.

Indexing a one-page résumé (4.5 KB) produces three chunks at the default 512-token size.
With `k_final=5`, **every query retrieves the entire document**, so recall is trivially perfect and the ablation table above would rate the configuration flawless.
Asked *"What did Henry do at QMIND?"*, the answer was still wrong: QMIND sat at character 2897 inside a 2,092-character chunk that also held a data-science role, an education entry, and two other clubs, and a 3B model could not pick it out.

Same question, same model, same document, only chunk size differs:

| chunk_size | chunks | Answer |
|---|---|---|
| 512 | 3 | *"I don't have that information in the provided documents."* |
| 192 | 6 | *"[2] states that Henry created an NLP program trained on a dataset of Reddit comments mapping to 1 of 27 emotions."* ✓ |

Reranking would have changed nothing here: with three chunks and `k_final=5`, there is nothing to reorder.
Larger chunks are not a retrieval problem, they are an *attribution* problem, and catching that class of defect needs the answer-side metrics (`clear-rag eval --generate`) rather than recall@k.

The lesson generalises past this project: a benchmark that only scores retrieval will report a healthy system while users get wrong answers.

### Measuring what retrieval metrics cannot see

The attribution suite closes that gap.
It runs with `--generate` and grades the **answers**, deterministically, with no judge model:

| Metric | Question it answers |
|---|---|
| false refusals | did the model say "I don't know" with the answer in front of it? |
| required mentions / wrong-section bleed | is the right content present, and content from the *wrong* section absent? (`must_not_mention` labels) |
| grounding / citation precision | do the cited chunks actually cover the labelled answer span? |

The suite (`evals/attribution/`) is a single fictional staff profile whose sections deliberately share vocabulary: a day job doing forecasting, an AI club doing NLP, projects that echo both.
One document means retrieval is trivially perfect in every configuration, so **every failure the suite reports is a generation failure.**

Measured on the bundled suite (12 answerable + 3 unanswerable questions):

<!-- results:attribution -->
| Model · chunk size | retrieval recall@5 | required mentions | grounding | citation precision |
|---|---|---|---|---|
| llama3.2 · 512 | 1.000 | 0.750 | 0.333 | 0.333 |
| qwen3.5:9b · 512 | 1.000 | 1.000 | 1.000 | 1.000 |
| llama3.2 · 192 | 1.000 | 0.750 | 0.500 | 0.458 |
| qwen3.5:9b · 192 | 1.000 | 1.000 | 1.000 | 0.917 |
<!-- /results:attribution -->

Reading it: retrieval metrics are a flat, useless 1.000 across every row, and grounding varies by a factor of three.
The 3B model *says* the right thing three times in four (mentions 0.750) while citing the wrong chunk two times in three; smaller chunks help its grounding somewhat (0.333 -> 0.500) but don't fix it.
The 9B model is essentially perfect at either chunk size.
Generated answers wobble by a question or two between runs at temperature 0.1, but the pattern has not.
This settles, with numbers, what an earlier debugging session found anecdotally on a real résumé: past a modest floor, **attribution quality is a property of the model far more than of the chunking**, and it is entirely invisible to recall@k.

```bash
clear-rag ablate --suite attribution --generate --save-results                # current model
CLEARRAG_CHAT_MODEL=llama3.2 clear-rag ablate --suite attribution --generate --save-results
```

### Reproducing the numbers

```bash
clear-rag eval                    # score the golden set with real models
clear-rag eval --suite sec        # the 10-K corpus: parsing/chunking/context measurable
clear-rag eval --generate         # also generate answers: refusal + required-mention accuracy
clear-rag ablate                  # sweep configurations, print the table above
clear-rag ablate --save-results   # merge the sweep into evals/results/<suite>.json
clear-rag parse-quality           # differential-test parser backends vs HTML ground truth
clear-rag eval --set rerank=true --set query_transform=multi   # override any knob
```

Every table in this README is rendered from `evals/results/<suite>.json`, and CI fails if a table was edited by hand or a three-decimal number in this prose is no longer vouched for by any results file.
Each row records the models and the date that measured it.
How the files merge and render: [docs/results-files.md](docs/results-files.md).
How the golden sets anchor relevance to character spans rather than chunk ids, and how recall@k is counted: [docs/evaluation.md](docs/evaluation.md).

---

## Parsing, structural chunking, contextual retrieval

Three more stages are measurable on a second benchmark built for the purpose: curated sections of two real SEC 10-K filings (Apple and Microsoft FY2023) as rendered PDFs.
Tag-stripped text from the same filings' HTML is kept as **parse ground truth**, so parser backends are differentially tested (`clear-rag parse-quality`) the same way BM25 is tested against SQLite FTS5.
A 42-question golden set (39 answerable) tags `table`, `structure` and `cross-company` questions; `clear-rag ablate --suite sec` sweeps parser x chunker x context with real models.

<!-- results:sec -->
| Configuration | recall@1 | recall@5 | MRR | nDCG@5 | table | structure | cross-company |
|---|---|---|---|---|---|---|---|
| **naive parser** | 0.538 | 0.872 | 0.678 | 0.764 | 0.636 | 0.875 | 0.889 |
| primitives parser | 0.436 | 0.846 | 0.596 | 0.686 | 0.545 | 0.875 | 0.778 |
| primitives + semantic chunking | 0.410 | 0.692 | 0.521 | 0.565 | 0.182 | 0.875 | 0.667 |
| primitives + breadcrumb context | 0.436 | 0.846 | 0.596 | 0.686 | 0.545 | 0.875 | 0.778 |
| primitives + LLM context | 0.462 | 0.846 | 0.611 | 0.698 | 0.545 | 0.875 | 0.778 |
| primitives + semantic + breadcrumb | 0.385 | 0.692 | 0.511 | 0.557 | 0.182 | 0.875 | 0.667 |
| docling parser † | 0.385 | 0.718 | 0.521 | 0.611 | 0.455 | 0.750 | 0.667 |

† imported from an earlier measurement rather than re-run here: 2026-08-23, docling is not installed in the current environment
<!-- /results:sec -->

Three findings, none of them the marketing version (full tables and caveats in [`evals/sec/README.md`](evals/sec/README.md)):

1. **Flat extraction wins on born-digital PDFs, and the hand-rolled parser beats the ML one.**
   These Chromium-rendered filings are pypdf's best case, and the geometric parser (`primitives`) outscores docling's layout models on both parse fidelity (word recovery 0.996 vs 0.988) and retrieval, while docling's aggressive table reconstruction loses two labelled answers outright.
   Structure's value flows to the stages that consume it (structural chunking, breadcrumbs, the Library's structure view), not to raw retrieval on clean renders.
   The differential test also caught two real parser bugs during development: a page-wide phantom grid built from 186 table-shading rects, and part-page column bands interleaving side-by-side lines.
2. **Semantic chunking regresses financial tables** (table recall 0.545 -> 0.182).
   Heading-bounded packing folds a statement's table into one large mixed chunk that ranks worse than the accidental isolation fixed-size cutting provides.
   The block model points at its own fix, atomic table chunks, and the metric to judge it is already in place.
3. **Contextual retrieval measured a null** on this corpus: identical recall under no context, breadcrumbs, and LLM-written context, within one question.
   Two companies with distinct vocabulary give the technique nothing to disambiguate; its motivating case is many near-identical documents.
   The free breadcrumb is the default; the LLM mode (cached by content hash so re-indexing is free) stays a knob.

`marker` is wired as a fourth backend (optional extra; note its GPL-3.0 licence and surya model-weight restrictions) and passes its contract test.
Its ablation row is pending: surya inference needs a GPU path or a local `llama-server`, and the CPU run was impractically slow.

---

## Interface

Five views.

- **Chat** streams each retrieval stage as it completes, then the answer.
- **Library** shows how a document was split: chunk boundaries drawn over the source text, overlap regions shaded darker, and a *structure* view of the typed blocks the parser recovered. Pin a chunk and the readout shows the contextual-retrieval preamble it was indexed under.
- **Lab** turns every pipeline knob into a control: change one setting, ask the same question again, and the runs sit side by side with the changed setting highlighted. Settings that rewrite the index trigger an explicit re-index from stored text, without needing the original files; a parser change is the one exception and applies to files uploaded afterwards. Knobs that exist in the config but are not built yet (HyDE, self-correction) appear disabled with a note, so the interface never pretends.
- **Results** shows the benchmark itself: every table in this README, read from the same committed files, with a row you can pin so the others are read against it, and a per-question panel that turns "recall@1 fell" into the questions whose first relevant chunk moved down and the ones that moved up.
- **Learn** explains each technique, with charts read from the same results files.

One-click **sample sets** (the engineering docs evaluation corpus, about 60 chunks at small chunk sizes, and the SEC 10-K sections) exist because a three-chunk résumé makes every comparison degenerate: below about 20 chunks each search returns everything and no setting visibly matters.

Every stage, metric and column explains itself on hover.
"Fuse (RRF)" means nothing until something tells you it merges two rankings so a chunk both searches liked beats one that only a single search ranked first.
The interface should not require the README.

### The retrieval inspector

A per-chunk table is the primary view, not a chart.
A chart only communicates when there is movement to see: index a one-page résumé and every retriever returns all three chunks, so a bump chart draws three flat lines and says nothing.
The table still reports exactly what happened, and stays readable at fifty candidates where a chart becomes spaghetti.
The rank-flow chart appears from five candidates up, where crossing lines earn their space.

### Colour

Monochrome carries the interface; colour carries only data.
In the retrieval inspector it does two jobs: which search found a chunk (vector, keyword, or both), and a stage slow enough to notice (one second and five seconds).
The Results view adds data encodings of its own (metric deltas, the pinned baseline row); see [docs/ui-design.md](docs/ui-design.md).
Fast is deliberately uncoloured, so in a typical query exactly one number is coloured, generation, and it is the one worth looking at.
The palette was validated for colour-vision deficiency and contrast against this project's actual surfaces; dropping green from the latency scale and moving keyword from orange to aqua both came out of that check.
Every coloured mark ships a visible text label.
Details: [docs/ui-design.md](docs/ui-design.md).

---

## Correctness, deliberately

Three decisions that invert what a RAG tutorial would tell you:

**The vector index is exact, not approximate.**
Under about 100k chunks, exhaustive cosine is single-digit milliseconds and has no parameters to misconfigure.
An approximate index is deferred until it can arrive as a *measured* experiment, recall@k against latency, rather than an unexamined day-one default.

**BM25 is differentially tested.**
A from-scratch ranking function is easy to write plausibly and hard to verify by reading.
`tests/index/test_bm25.py` indexes the same corpus into SQLite's FTS5 and asserts both implementations agree.

**Changing the embedding model refuses to serve.**
Vectors written by a different model are not comparable.
The embedder identity is stored beside the index; a mismatch stops queries and asks for a re-index instead of quietly returning noise.
The ablation sweep leans on the same identity: a variant that names an embedding model gets an index of its own, so a reused workspace can never hand it vectors from another model and score the row as a column of zeros.

---

## What the predecessor got wrong

Building this made three real bugs in the 2024 project legible.
They are called out in code comments where the fix lives, and two have regression tests:

| Bug | Consequence | Fixed in |
|---|---|---|
| The history-aware retriever's prompt said *"provide a response…"*, but its output is fed straight into the retriever as a **search query**, with no documents available yet | From turn two onward, the index was searched with a hallucinated answer | `generate/prompt.py:REWRITE_SYSTEM`, tested in `test_followup_is_rewritten_not_answered` |
| Document vectors were normalised by hand; query vectors were not | Reported similarity scores were meaningless (ranking survived by luck) | `providers/base.py:l2_normalise` |
| Answer quality was scored as cosine similarity to its own context | Rewarded verbatim copying, and **penalised a correct "I don't know"** | Refusal is recorded as correct behaviour, tested in `test_refusal_is_recorded_as_such` |

Plus: the index was rebuilt from scratch on every launch (`save_local` was called, `load_local` never was), and chunk overlap was 50%, which doubled the index and filled top-k with near-duplicates of one passage.

---

## Development

```bash
make dev      # backend (auto-reload) + frontend (HMR), open http://localhost:5173
make test     # pytest + Vitest, no models required
make e2e      # one Playwright path against a mocked API
make lint     # ruff, mypy, tsc
```

Tests run entirely on **fake providers**: a deterministic bag-of-words hash embedder and a scripted chat model.
That is the one piece of infrastructure that makes a RAG project testable, and it powers a regression gate that runs the golden set through the real pipeline in CI.
Details: [docs/dev-environment.md](docs/dev-environment.md) for the dev loop, port and Docker, and [docs/testing.md](docs/testing.md) for the suites and gates.

Evaluation came before reranking on purpose: build the ruler before the thing you want to measure, so every later change arrives with a before-and-after number rather than a claim.
What comes next, in order: [docs/specs/roadmap.md](docs/specs/roadmap.md).

## Documentation

[`AGENTS.md`](AGENTS.md) is the entry point for working in this repo: commands, repo map, conventions, and an index of every doc.
[`docs/`](docs/) holds one reference doc per concept (pipeline, ingestion, indexes, providers, evaluation, UI), and [`docs/specs/`](docs/specs/) holds designs for planned work.
