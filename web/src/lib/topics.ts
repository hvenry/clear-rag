/**
 * The Learn section's content: one entry per technical concept the app exhibits.
 *
 * Written against this project specifically — the numbers are real measurements from
 * the bundled benchmarks, and each topic ends with where to watch the concept live in
 * the app. Inline backticks render as code.
 */

export interface Topic {
  id: string;
  title: string;
  summary: string;
  body: string[];
  formula?: { text: string; caption: string };
  seeIt?: string;
}

export interface TopicGroup {
  title: string;
  topics: Topic[];
}

export const TOPIC_GROUPS: TopicGroup[] = [
  {
    title: "The query pipeline",
    topics: [
      {
        id: "query-rewriting",
        title: "Query rewriting",
        summary: "Making follow-up questions searchable before anything is retrieved.",
        body: [
          "A search index has no memory. Ask “what did Priya build?” and then “what about at the club?”, and that second question — the one actually sent to the retrievers — contains none of the words that would find the answer. Query rewriting uses the chat history to turn it into a standalone query (“what did Priya build at Signal Society?”) before any search runs.",
          "The prompt for this step has one job: rewrite, never answer. That distinction is load-bearing. This project's predecessor used a prompt that said “provide a response that directly addresses the user's query” — but the rewriter's output goes straight into the search index, and at that moment no documents have been retrieved to answer from. From the second turn onward it was searching the corpus with a hallucinated answer. The failure was invisible because the query that actually got searched was never shown anywhere.",
          "It costs one full LLM call per follow-up, which is why the first question of a conversation skips it entirely.",
          "Query expansion lives in the same stage. With the Lab's expansion knob on multi, the model also writes a few alternative phrasings of the (rewritten) question and every one of them is searched — see *Query understanding (Phase 5)* for what that measured."
        ],
        seeIt: "Ask a follow-up question in Chat — the “searched as:” line under the stage strip shows exactly what the retrievers received."
      },
      {
        id: "keyword-search",
        title: "Keyword search (BM25)",
        summary: "Exact-term matching over an inverted index, scored by rarity and saturation.",
        body: [
          "An inverted index maps every term to the chunks containing it — so a query only touches chunks sharing at least one word with it, and corpus size stops mattering. BM25 then scores each match on two ideas: rare terms count more than common ones (idf — matching `X-RateLimit-Remaining` means far more than matching `the`), and repeated terms saturate (the second occurrence of a word adds less than the first, so a chunk can't win by spamming).",
          "Keyword search is strong exactly where vector search is weak: identifiers, error codes, command names, proper nouns. On this project's benchmark corpus — full of strings like `hb bootstrap` and `422` — BM25 alone beats vector search alone (recall@1 0.766 vs 0.573).",
          "The implementation here is written from the formula, and its correctness is established by a differential test: the same corpus is indexed into SQLite's FTS5 and both implementations must agree on the ranking. A from-scratch scoring function is easy to write plausibly and hard to verify by reading."
        ],
        formula: {
          text: "score(D,Q) = Σ idf(q) · f(q,D)·(k1+1) / (f(q,D) + k1·(1 − b + b·|D|/avgdl))",
          caption: "k1=1.2 controls saturation, b=0.75 controls length normalisation — matching FTS5's defaults so the differential test compares like with like."
        },
        seeIt: "In any answer's retrieval table, hover a Keyword rank — the stage chip's diagnostics list exactly which of your query's terms matched."
      },
      {
        id: "embeddings",
        title: "Vector search & embeddings",
        summary: "Matching on meaning: text as points in space, relevance as distance.",
        body: [
          "An embedding model maps text to a vector — a list of a few hundred numbers — such that texts with similar meaning land near each other. Search is then geometry: embed the question, measure the angle to every chunk's vector (cosine similarity), return the closest. No shared words required: “where did she study?” finds “Bachelor of Computing, Lakeshore University”.",
          "Two details are easy to get wrong. First, cosine similarity only means anything if every vector is normalised to length one — this project's predecessor normalised documents but not queries, which silently turned its reported scores into noise (the ranking survived by luck). Second, modern embedding models are asymmetric: questions and passages get different prefixes before embedding (`search_query:` vs `search_document:` for nomic). Skipping the prefixes costs recall without ever raising an error, so here the query/document distinction is part of the provider's type signature.",
          "The index is deliberately exact — a full matrix multiply over every chunk — rather than approximate. Under ~100k chunks that is single-digit milliseconds, with no parameters to mistune and no recall loss to explain. Approximate search (HNSW) is a planned experiment precisely so its speed/recall trade arrives measured rather than assumed."
        ],
        seeIt: "Library → Vector map shows the actual geometry: every chunk as a point, and your question dropping in among its neighbours."
      },
      {
        id: "hybrid-fusion",
        title: "Hybrid retrieval & RRF",
        summary: "Two searches, one ranking — merged by rank, not by score.",
        body: [
          "Keyword and vector search fail differently: one misses synonyms, the other misses exact identifiers. Hybrid retrieval runs both and merges the rankings — and on the bundled benchmark, that merge is the whole story: recall@5 goes from 0.871 (vector alone) and 0.903 (keyword alone) to 0.968 combined, and every distractor question that either method alone got wrong is resolved.",
          "The merge cannot simply add scores: BM25 scores are unbounded sums while cosine lives in [−1, 1], so any weighting of raw scores needs per-corpus tuning that rots as the corpus changes. Reciprocal Rank Fusion sidesteps this by consuming only rank positions. A chunk both searches liked beats a chunk only one search ranked first — agreement between independent methods is the strongest signal available.",
          "The damping constant k (60, from the original paper) decides how much a single #1 can dominate: at small k rank one towers over rank two; at large k the curve flattens and consensus matters more than position. The Lab lets you sweep it and watch the fused ranking reorder."
        ],
        formula: {
          text: "RRF(d) = Σ over searches 1 / (k + rank(d))",
          caption: "Rank 1 in one list contributes 1/61; ranks 3 and 4 in both lists contribute 1/63 + 1/64 — and win."
        },
        seeIt: "The retrieval table's “Found by” column shows which search produced each chunk; the Fused column shows where agreement moved it."
      },
      {
        id: "reranking",
        title: "Cross-encoder reranking",
        summary: "A slower, smarter model re-scores the shortlist the fast searches proposed.",
        body: [
          "The embedding model is a bi-encoder: it reads the query and each chunk separately, and compares the two summaries. That's what makes it fast enough to search everything — and it's also the ceiling on its accuracy, because the model never sees the query and the text together. A cross-encoder does exactly that: one transformer reads the concatenated pair and scores their actual interaction. Far more accurate, and far too slow to run over a corpus.",
          "So the pipeline uses each where it's strong: cheap retrievers propose ~50 candidates, and the cross-encoder re-scores only that shortlist. Here that's ms-marco-MiniLM — 23 MB of quantised ONNX, downloaded on first use, a few hundred milliseconds per query on a laptop CPU, no GPU and no torch.",
          "The measured effect on the bundled benchmark is the largest of any single technique: recall@1 rises from 0.734 to 0.927 and MRR from 0.841 to 0.965. Fusion already got the right chunk somewhere into the top five; the reranker puts it first — which matters because first is what a small generator actually attends to."
        ],
        seeIt: "Enable reranking in the Lab and re-ask a question: a fourth column appears in the retrieval table, with ↑/↓ arrows showing what the cross-encoder moved."
      },
      {
        id: "context-assembly",
        title: "Context assembly",
        summary: "Packing the survivors into the model's budget — and saying what was dropped.",
        body: [
          "The retrieved chunks now have to fit into a token budget. Assembly walks the final ranking, packs chunks until the budget is spent, and numbers each one — those numbers are what the model cites, and what citation validation later checks against.",
          "Two quiet decisions here shape answer quality. Overlapping spans are deduplicated: adjacent chunks share their overlap window by construction, so a naive top-k regularly feeds the model the same sentences twice, spending budget on repetition. And everything dropped — over-budget, or already covered by a higher-ranked chunk — is recorded in the trace rather than vanishing, because “the model never saw the chunk that had the answer” is the single most useful fact when debugging a wrong answer.",
          "The exact packed prompt is preserved in the trace: what the model was actually given is never a matter of reconstruction."
        ],
        seeIt: "The Assemble stage chip reports chunks used, dropped, and budget spent; rows marked “dropped” in the retrieval table were retrieved but never shown to the model."
      },
      {
        id: "generation-citations",
        title: "Generation, citations & refusal",
        summary: "Answering from the context only — with verifiable pointers back into it.",
        body: [
          "The generator is instructed to use only the numbered passages, cite each claim as [n], and refuse — with one exact sentence — when the context doesn't contain the answer. Every part of that is checked rather than trusted: markers in the answer are validated against the passages actually supplied, and a citation of [7] when five passages were sent is discarded rather than rendered, because a fabricated source with a real-looking chip is worse than no source.",
          "Refusal is a correct behaviour, not a failure. The predecessor project scored answers by cosine similarity to the retrieved context — a metric that rewarded verbatim copying and actively penalised a correct “I don't know”. Here refusal on an unanswerable question scores positively, and refusal on an answerable one is tracked separately as over-refusal.",
          "One local-model trap worth knowing: reasoning models spend output tokens thinking before they answer. The first such model this project ran produced 3,751 thinking frames and zero answer, then hit its output limit — an apparently broken model that was actually a default setting. Thinking is disabled for RAG answering, where the reasoning budget is better spent on retrieval quality."
        ],
        seeIt: "Click any citation chip — the source opens with the exact cited span highlighted. Grey markers in an answer were invented by the model and stripped."
      }
    ]
  },
  {
    title: "Indexing",
    topics: [
      {
        id: "parsing-spans",
        title: "Parsing & character spans",
        summary: "One authoritative text per document, with every chunk anchored into it.",
        body: [
          "When a file is ingested, its extracted text becomes the single source of truth, and every chunk records the exact character range it occupies in that text. That one invariant pays for most of the app's precision: a citation can highlight the exact sentences used rather than saying “document 2, score 0.71”, the chunk inspector can draw boundaries over the original, and the evaluation suite can label answers by position in a way that survives any re-chunking.",
          "Parsing now also emits structure: every document carries typed blocks — headings with levels, paragraphs, tables — each anchored to a span of the same text. Structure is what the structural chunker cuts along and what breadcrumb contexts are built from, so a parser that recovers it well quietly improves two other stages.",
          "It also enables re-indexing without the original files: change the chunk size and the corpus is re-cut from stored text in seconds. The one thing re-indexing cannot do is re-parse — the original bytes are gone — so changing the parser backend asks for a re-upload instead of pretending.",
          "Parsing is also where silent quality loss happens. A scanned PDF with no text layer extracts as nothing — detected and refused with a pointer to OCR, rather than indexed as an empty document that can never be retrieved."
        ],
        seeIt: "Every citation lists its character range (“chars 1799–3913”); the Library draws those same ranges over the source text."
      },
      {
        id: "parser-backends",
        title: "PDF parsing backends",
        summary: "The hardest stage of RAG, made pluggable, visible — and measured three ways.",
        body: [
          "A PDF contains no paragraphs, headings, columns or tables — only positioned glyphs and drawn lines. Everything a parser reports is inference from that geometry, which makes parsing the stage where RAG systems quietly lose the most and explain the least. Here it is a config knob like any retrieval technique: `naive` (flat pypdf extraction, the baseline), `primitives` (a hand-rolled layout parser: column detection, heading inference, header/footer stripping, ruled and aligned tables), and `docling` / `marker` — the ML-model parsers — as optional extras behind the same interface.",
          "Correctness is established differentially, the same way this project tests BM25 against FTS5. The SEC benchmark corpus is built from filings whose HTML source is downloaded alongside the rendered PDFs, so ground-truth text exists for every page — `clear-rag parse-quality` scores each backend on word recovery (did the words survive?) and order similarity (did they come out in reading order?). That test caught two real bugs during development: a page carrying 186 table-shading rectangles was being read as one page-wide grid that swallowed the prose between two tables into phantom cells, and part-page column layouts were interleaving side-by-side lines. Order similarity jumped from 0.78 to 0.99 when they were fixed — a number, not an impression.",
          "The measured result inverts the folklore. On this corpus the hand-rolled parser matches or beats docling's 300 MB of layout models on both parse fidelity (recovery 0.996 vs 0.988) and retrieval (recall@5 0.846 vs 0.718 — docling's aggressive table reconstruction loses labels and buries table content in worse-ranking chunks). And flat extraction beats both, because these are born-digital single-column renders: pypdf's best case. The honest conclusion is scoped, not triumphant: on clean PDFs, structure buys retrieval nothing — its value flows to the stages that consume it, and the corpus where ML parsing should win (scans, native multi-column) does not exist here yet.",
          "Scope is deliberate: no OCR, no nested tables. A missing backend degrades loudly — the trace records the fallback to `naive` and names the install command — because a knob that silently does nothing is worse than one that says so."
        ],
        seeIt: "Lab → Ingestion → PDF parser picks the backend for new uploads; Library → structure shows what it recovered. `clear-rag parse-quality` prints the differential table, and a PDF's ingest trace records which backend actually ran — including any fallback."
      },
      {
        id: "chunking",
        title: "Chunk size",
        summary: "The unit of retrieval — and, it turns out, mostly a generation concern.",
        body: [
          "Chunks are what gets embedded, indexed, retrieved and cited, so their size shapes everything downstream. Large chunks carry context but blur sections together; small chunks are precise but can orphan the sentence that made them meaningful. The splitter here cuts at natural boundaries (paragraphs, then sentences) within a token budget, and snaps to word boundaries — an early version stepped back a fixed character count and started nearly every chunk mid-word, which made citation previews look corrupt.",
          "The measured result is more interesting than the folklore. For retrieval, chunk size barely matters on this corpus: every size from 96 to 1024 tokens lands within a few points. For attribution — whether the model uses the right part of what it retrieved — it matters enormously at the small-model end: a 3B model given a one-page profile as three 500-token chunks refused or mis-cited questions whose answers were in front of it, and improved sharply at 192 tokens. A 9B model was near-perfect at either size.",
          "The general lesson: past a modest floor, chunking tunes the generator's job, not the retriever's."
        ],
        seeIt: "Lab → change chunk size → re-index, then compare runs; Library shows the new boundaries immediately."
      },
      {
        id: "semantic-chunking",
        title: "Structural (semantic) chunking",
        summary: "Cutting where the document changes topic — and the table that says when not to.",
        body: [
          "Fixed-size chunking cuts wherever the token budget lands, which is how a résumé chunk ends up holding half of one job plus two unrelated sections — the attribution failure this project measured in its answer-side suite. The structural chunker cuts where the document says its topics change instead: whole heading-bounded sections pack together up to the budget, and only a section too big for one chunk gets subdivided — by embedding adjacent passages and splitting where the similarity between neighbours drops, so the cut lands at the topic shift rather than at an arbitrary token count. No overlap, deliberately: overlap is insurance against arbitrary cuts, and these cuts aren't.",
          "The measured result is a warning, not a victory lap. On the SEC corpus, semantic chunking *lost* to fixed-size chunking — recall@5 0.692 vs 0.846, and on financial-table questions it fell to a third, 0.545 → 0.182. The mechanism is visible in the misses: packing folds a statement's table into one large section chunk whose search profile is diluted by the surrounding prose, while dumb fixed-size cutting accidentally isolates table rows into chunks that match queries cleanly.",
          "That negative number is the system working as designed — the knob shipped with a before-and-after instead of a claim, and it points at its own fix: tables are already typed blocks, so treating them as atomic chunks instead of packing them into sections is a small change with a metric already waiting to judge it."
        ],
        seeIt: "Lab → Ingestion → Chunker → semantic, re-index, then compare a table question against fixed-size in side-by-side runs. Library → structure shows the section boundaries it cuts along."
      },
      {
        id: "contextual-retrieval",
        title: "Contextual retrieval",
        summary: "Situating each chunk before it's indexed — free breadcrumbs vs paid LLM prose.",
        body: [
          "A chunk that says “the Company's revenue grew 12%” is unambiguous inside its document and meaningless in an index holding several companies' filings. Contextual retrieval prepends situating context to each chunk before embedding and keyword-indexing — only to the *indexed* text, never the stored text, so spans, citations and highlighting are untouched.",
          "Two modes, priced very differently. `breadcrumb` derives the context from parse structure — `apple-10k-2023 › Item 1A Risk Factors › …` — deterministic, instant, free. `llm` is the technique as Anthropic describes it: a model writes one or two situating sentences per chunk, one generation each at index time, cached by content hash so re-indexing an unchanged document costs nothing.",
          "Measured on the SEC corpus: neither moved retrieval at all — recall@5 0.846 under no context, breadcrumbs, and LLM prose alike. The two companies' vocabularies are distinct enough that chunks were never ambiguous in the way the technique repairs; its motivating case is many near-identical documents, and this corpus isn't that. So the free breadcrumb is the default and the paid mode stays a knob — with one open question the retrieval metrics can't answer: the context is also visible to the *generator*, so the answer-side suite may yet separate what the ranked list cannot."
        ],
        seeIt: "Lab → Ingestion → Contextual retrieval → breadcrumb, re-index, then pin any chunk in the Library — the readout shows the exact preamble it was indexed under (“indexed as: …”)."
      },
      {
        id: "overlap",
        title: "Chunk overlap",
        summary: "Duplicated text at every boundary — insurance with a measurable premium.",
        body: [
          "Splitting text risks cutting an answer in half: the question matches the first chunk, the answer's second half lives in the next, and neither chunk alone contains enough to answer from. Overlap duplicates a window of text across every boundary so anything near a cut exists whole in at least one chunk.",
          "It is insurance, and the premium is real: at the predecessor's 50% overlap, half the index was duplicate text and the top of every ranking filled with near-copies of the same passage. Around 10–15% buys the boundary protection without the bloat.",
          "Overlap also produces the one genuinely confusing artifact in the UI: a chunk's opening characters can belong to the previous chunk too, so previews skip past the shared region and an “overlap” badge explains the duplication rather than letting it read as a bug."
        ],
        seeIt: "Library → open a document: the darker bands are text living in two chunks at once. That's the overlap, drawn to scale."
      },
      {
        id: "embedding-space-guard",
        title: "The embedding-space guard",
        summary: "Vectors from different models are not comparable — so the index refuses to mix them.",
        body: [
          "Every embedding model defines its own space: the same sentence embeds to completely unrelated vectors under two different models. Swap the model with an existing index on disk and every similarity score becomes noise — while returning results that look perfectly normal.",
          "Because that failure is silent, the defence is structural: the index stores the identity of the model that wrote it, and a mismatch at startup refuses to serve queries and names the fix. The fix itself is one click — re-index rebuilds every vector from stored text under the new model.",
          "The principle generalises and shows up across this project: where a mistake would fail silently (asymmetric prefixes, mixed embedders, mid-word chunk starts), make it unrepresentable or make it loud. Quality problems you can see get fixed; the silent ones ship."
        ],
        seeIt: "Change `CLEARRAG_EMBED_MODEL` and restart — the health banner explains the refusal and offers the re-index."
      }
    ]
  },
  {
    title: "Measurement",
    topics: [
      {
        id: "retrieval-metrics",
        title: "recall@k · MRR · nDCG",
        summary: "Three views of one ranked list — found at all, found first, found early.",
        body: [
          "All retrieval metrics score the same object: the ranked list of chunks, against labels saying where the answer actually lives. recall@k asks whether the labelled answer appears anywhere in the top k — the floor, since the generator cannot use what retrieval never surfaced. MRR (mean reciprocal rank) asks how high the first relevant chunk sat: 1 for first place, ½ for second, decaying fast — a proxy for “did we lead with the right thing”. nDCG credits every relevant chunk by position on a gentler curve.",
          "The k matters more than the metric. On a small corpus recall@5 sits at or near 1.000 for every hybrid configuration and stops discriminating — the interesting differences live at recall@1 and MRR, which is exactly where reranking shows its 0.734 → 0.927 jump. A results table whose columns cannot distinguish its rows is worse than none, because it looks like evidence.",
          "One definition here is deliberately unusual: recall counts labelled answer spans covered, not relevant chunks retrieved. Chunk counts change whenever chunking changes; spans in the source document don't — so scores stay comparable across every configuration the Lab can produce."
        ],
        seeIt: "`clear-rag ablate` prints these per configuration; the README's results table is its output, verbatim."
      },
      {
        id: "answer-metrics",
        title: "Answer-side metrics",
        summary: "Grading what the model did with perfect context — where retrieval metrics go blind.",
        body: [
          "Retrieval metrics stop at the ranked list. But the failure that motivated this suite happened after a perfect retrieval: a small model with the entire document in context answered about the wrong section. Every retrieval metric read 1.000; the answer was wrong. So the answer itself is graded, deterministically, with no judge model.",
          "Four checks triangulate the observed failure modes. False refusals: the model said “I don't know” with the answer in front of it. Required mentions: the answer contains what it must. Wrong-section bleed: the answer also contains content from a section the question wasn't about — labelled per-question via `must_not_mention`, which is what makes attribution measurable at all. Grounding and citation precision: the cited chunks actually cover the labelled answer span, not just any retrieved text.",
          "The bundled attribution suite is a single document on purpose: retrieval is trivially perfect in every configuration, so every failure it reports is a generation failure. Measured on it, a 3B model grounded only 42% of its answers while mentioning the right content 92% of the time — right words, wrong receipts — and a 9B model scored 100/100. Invisible to recall@k, decisive in practice."
        ],
        seeIt: "`clear-rag eval --suite attribution --generate` — the README's model × chunk-size table comes from exactly this command."
      },
      {
        id: "golden-set",
        title: "The golden set",
        summary: "Labels anchored to quotes, resolved to spans — so the benchmark survives its own experiments.",
        body: [
          "A benchmark needs ground truth: for each question, where does the answer live? The tempting label — “the answer is chunk #12” — self-destructs, because chunk ids change the moment chunking configuration changes, and comparing chunking configurations is a primary purpose of the benchmark.",
          "Labels here are quotes: a verbatim snippet of the source document, resolved to exact character positions at load time. Quotes anchor content words in order, with everything between them matched flexibly — whitespace, line wraps, and the punctuation renderers disagree about (a PDF writes `(77,046)` where HTML writes `( 77,046 )`, a table row is `a | b` to one parser and `a b` to another). A quote that matches nothing — or matches ambiguously — fails loudly at authoring time, because an ambiguous label is worse than no label.",
          "The SEC suite adds a twist the parser ablation forced: quotes resolve against *parsed* text, and different parser backends produce different text. In ablation runs a quote the parse lost scores as a retrieval miss for that backend — the parse losing the answer is a result to measure, not a crash — while authoring-time validation stays strict.",
          "The set also includes questions the corpus cannot answer, with no labels at all. They exist to measure refusal: a system that never says “I don't know” is not measuring one of the two ways RAG fails."
        ],
        seeIt: "`evals/golden.jsonl` and `evals/sec/golden.jsonl` — every line is one question with its quote-anchored labels; a test fails CI if any quote stops resolving."
      },
      {
        id: "ablation",
        title: "Ablation & the config hash",
        summary: "One variable at a time, every result attributable to exact settings.",
        body: [
          "An ablation isolates one decision: run the identical benchmark under configurations differing in a single knob, and the score difference is that knob's measured worth. It is how “hybrid beats dense-only” and “reranking is the biggest single win” stopped being opinions in this project.",
          "The mechanism that keeps it honest is the config hash — a fingerprint of every pipeline setting, stamped onto every trace and every eval run. Two results are comparable exactly when their hashes differ by the knob under test; a result whose configuration can't be stated is an anecdote.",
          "A deterministic subset runs in CI as a regression gate: fake providers (a hash-based embedder, a scripted chat model) make the whole pipeline runnable in milliseconds with nothing installed. Those scores measure nothing about quality — but they are bit-for-bit reproducible, so any drop means a code change broke chunking, BM25, fusion or assembly. Getting them reproducible surfaced a real bug: random chunk ids were breaking score ties differently on every run."
        ],
        seeIt: "The hash in the header chip is the current configuration's fingerprint; every Lab run card carries the hash it ran under."
      }
    ]
  },
  {
    title: "Future improvements",
    topics: [
      {
        id: "queued-experiments",
        title: "The queued experiments",
        summary: "Three items the existing measurements already ordered — no new ideas required.",
        body: [
          "**Atomic table chunks.** The Phase 4 ablation measured structural chunking *hurting* financial-table questions: recall@5 fell from 0.545 to 0.182, because heading-bounded packing folds a statement's table into one large section chunk whose BM25 term statistics and embedding are diluted by surrounding prose. The fix falls out of the block model: in the structural chunker, a block of kind `table` becomes its own chunk instead of packing into its section — a table's rows are a retrieval unit in a way prose paragraphs are not. The sec suite's `table`-tagged questions are the judge, already waiting.",
          "**The answer-side sec run.** Retrieval metrics scored breadcrumb context, LLM-written context and no context identically (recall@5 0.846 across all three) — but the context string is prepended to what the *generator* reads too, and answer-side metrics (grounding, citation precision, wrong-section bleed) may separate what the ranked list cannot. The command is `clear-rag ablate --suite sec --generate`. It is an overnight run for plain arithmetic reasons: six-plus configurations × 42 questions × one full local generation each, plus the LLM-context variant paying one generation per chunk at index time — a few seconds per generation on local hardware compounds to hours of wall-clock. Start it before bed; read the table over coffee.",
          "**The marker row.** marker is wired as a fourth parser backend and passes its contract test, but its ablation row was cancelled: surya's recognition model needs an inference server, and CPU llama.cpp was impractically slow. Completing the three-way ML-parser comparison needs a GPU path — either `nvidia-container-toolkit` so surya's vllm container can run, or a CUDA build of `llama-server` with `SURYA_INFERENCE_BACKEND=llamacpp`."
        ],
        seeIt: "`evals/sec/README.md` holds the tables these experiments extend; every result lands as a new row, not a claim."
      },
      {
        id: "phase5-query-understanding",
        title: "Query understanding (Phase 5)",
        summary: "One built, three queued: the techniques that transform the question before retrieval sees it.",
        body: [
          "**HyDE** (hypothetical document embeddings): ask the LLM to *answer* the question from imagination, embed that hypothetical answer, and search with its vector instead of the question's. The logic: questions and passages occupy different registers — \"why is my build slow?\" shares little vocabulary or embedding-space geometry with the dense prose that answers it, but a hallucinated answer is register-matched to real answers. Costs one generation per query; helps most when question phrasing diverges from document phrasing, does nothing when they already match.",
          "**Multi-query expansion** — built. The chat model writes a few alternative phrasings of the resolved question and every one of them is searched. Fusion happens in two levels rather than one flat merge: each retriever first fuses its own rankings across the phrasings by reciprocal rank, so keyword and vector search still each emit a single ranking and the inspector can still say which search found a chunk; then the two retrievers fuse as before. The price is one generation per question plus one extra search per phrasing. Nine `paraphrase` questions were added to the golden set for it — questions whose wording shares almost no words with the passage that answers them — because a technique ablated against a corpus it cannot help measures zero. Measured: on hybrid + RRF it lifts the paraphrase column from 0.778 to 1.000, recovering both questions fusion missed outright — and lowers recall@1 from 0.734 to 0.653, because the phrasings pull in near-misses that rank fusion then promotes over the exact hit. Stacked on the reranker it changes nothing, for a structural reason: at 512 tokens this corpus is eleven chunks and each search returns fifty, so the shortlist is the corpus and the cross-encoder decides the order alone, at a fraction of the cost. A recall lever with a precision bill; on this corpus the reranker is the better buy, and the case expansion was built for — a corpus large enough that the shortlist is a real cut — is one the benchmark cannot yet make.",
          "**Decomposition**: split a compound question (\"compare Apple's and Microsoft's tax rates\") into sub-questions, retrieve per sub-question, and pack the union. The sec suite's `cross-company` questions are the ready-made test set — today a single query has to hope both companies' passages surface in one ranking.",
          "**Self-correction**: after retrieval, have the model grade whether the candidates can answer the question; if not, rewrite the query and retry once — bounded at one retry, because an unbounded loop is a latency bug wearing a quality costume.",
          "One discipline applies to all four: before building any of them, add golden questions that *should* benefit. A technique ablated against a corpus it cannot help measures zero and teaches nothing — the corpus has to contain the failure the technique exists to fix."
        ],
        seeIt: "Lab → Conversation: switch Query expansion to multi and re-ask a question. The chat shows what else was searched, and the retrieval table's Keyword and Vector columns are each fused across the phrasings. HyDE and self-correction still sit greyed out."
      },
      {
        id: "retrieval-beyond",
        title: "Retrieval beyond Phase 5",
        summary: "Four measured experiments on the index itself: granularity, embedders, compression, tokenisation.",
        body: [
          "**Sentence-window / parent expansion**: retrieve small, precise chunks, then expand each hit to its neighbours or its parent section at assembly time. This attacks the tension the chunk-size ablation documented — small chunks retrieve precisely but orphan context; large ones blur sections together. The block model makes \"parent section\" a free lookup: every chunk's span nests inside a heading-bounded section span.",
          "**A second embedder**: `ollama pull mxbai-embed-large` (1024-dim vs nomic's 768) and the comparison becomes runnable — the header's model selector switches it, the embedding-space guard forces the re-index that keeps vectors comparable, and the golden set scores the difference. Embedding choice is the single most cargo-culted decision in RAG; here it can be a table row.",
          "**Vector compression**: quantise stored vectors (int8, or binary with Hamming distance) or truncate Matryoshka dimensions, and plot recall against index size. At this corpus scale the win is educational rather than practical — which is exactly the project's lane — and the method pairs with Phase 6's HNSW experiment, which only becomes interesting near ~100k chunks (a corpus-synthesis script is the real prerequisite there).",
          "**BM25 refinements**: porter stemming and stopword removal as toggles on the hand-rolled index, differentially tested against SQLite FTS5's porter tokenizer the same way the base implementation was. Stemming trades exact-identifier precision (the corpus's `X-RateLimit-Remaining` strength) for morphological recall (\"deployments\" matching \"deployment\") — a genuine tension worth a number."
        ],
        seeIt: "`clear-rag ablate` is the harness for every one of these — each lands as a row with a config hash, or it did not happen."
      },
      {
        id: "product-completeness",
        title: "Product completeness",
        summary: "The non-experimental backlog: closing gaps rather than measuring techniques.",
        body: [
          "**OCR**: the one documented parser scope hole. Scanned PDFs currently refuse with a pointer to `ocrmypdf`; integrating that as an opt-in preprocessing step (detect empty extraction → offer OCR → re-parse) closes it without dragging OCR models into the core install.",
          "**A traces history view**: every query's full trace is already persisted to SQLite and served at `/api/traces`, but no page renders them — the stored pipeline history is invisible. A `/traces` route is the natural next use of the router, and replaying an old trace through the existing inspector components is mostly wiring.",
          "**Conversation persistence**: the chat session deliberately lives in memory and dies with the tab. Persisting it (localStorage first; a Zustand store if it grows into multiple named sessions) was the concrete trigger identified when state management was designed — the architecture is waiting for the requirement, not the other way around.",
          "**URL ingestion**: paste a link, ingest the page. The HTML-to-blocks extraction written for the SEC corpus fetcher is most of the implementation; what remains is an endpoint and a paste target.",
          "**Electron packaging** (Phase 6): only if \"installable local app for non-terminal users\" becomes a goal — `make serve` already covers everyone comfortable with a terminal."
        ],
        seeIt: "`clear-rag serve` on a LAN address is the zero-work deployment today; everything above widens who can use it and what it remembers."
      }
    ]
  }
];

export const ALL_TOPICS: Topic[] = TOPIC_GROUPS.flatMap((g) => g.topics);

/** Stage name → topic id, for “explain” links from the pipeline strip. */
export const STAGE_TOPIC: Record<string, string> = {
  parse: "parser-backends",
  chunk: "chunking",
  transform: "query-rewriting",
  bm25: "keyword-search",
  dense: "embeddings",
  fuse: "hybrid-fusion",
  rerank: "reranking",
  assemble: "context-assembly",
  generate: "generation-citations"
};
