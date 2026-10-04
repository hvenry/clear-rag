# Web UI

The React single-page app in `web/` that streams the pipeline, inspects retrieval, and turns every knob and benchmark into something you can explore.

## Why
The project's claim is that retrieval should be visible, so the interface is the product rather than a wrapper.
It also has to explain itself: a stage called "Fuse (RRF)" means nothing until something on screen says what it does.

## How it works
`web/src/main.tsx` mounts the router and a TanStack Query client with retries and refetch-on-focus off, because a local backend that fails is down, not flaky.
`web/src/app/App.tsx` is the route map, and every view, document and topic is a deep-linkable URL.
`web/src/app/Layout.tsx` owns the header, navigation and the chat session, and passes them to views through the router's outlet context.

### Layout of `web/src`
- `app/` - shell: routes, layout, header controls (runtime, model, health, theme), session hook, cross-view navigation.
- `components/` - shared primitives (panels, popovers, selects, segmented controls, the chart kit) and `components/retrieval/` for the inspector.
- `views/` - one folder per view.
- `lib/` - API client, query hooks, types, and the self-explaining metadata (`stages.ts`, `knobs.ts`, `topics.ts`, `results.ts`, `benchmarks.ts`).

### Views
- **Chat** (`/chat/:sessionId`) streams each stage into a stage strip, then the answer with clickable citation chips.
  A session rail lists conversations and their document scope, and a telemetry panel charts every stored trace.
- **Library** (`/library`, `/library/:docId`, `/library/map`) lists documents and draws chunk boundaries, overlap and parsed blocks over the source text.
  The map view plots the corpus embedding space and drops a question into it.
  A citation click lands here with its highlight span in `location.state`, since a highlight is reading position, not an address.
- **Lab** (`/lab`) turns every knob into a control and keeps runs side by side with changed settings highlighted.
  A dirty draft config is applied before each run; ingestion knobs instead require an explicit re-index button.
- **Results** (`/results/:suite`) renders the committed benchmark tables, lets you pin a row to read the others against, and opens per-question comparisons.
- **Learn** (`/learn/:topicId`) has one page per concept the app exhibits, written against this project's measurements.

### Server state vs client state
`web/src/lib/queries.ts` holds server-owned data (health, config, documents, sessions, traces) in the query cache, and mutations name the keys they invalidate.
Client-owned state (a streaming turn, Lab run cards, a draft config) stays in components.
The sample import lives in a module-level store (`web/src/lib/importer.ts`) because it outlives the view that starts it.

### Sessions
`useChatSession` in `web/src/app/session.ts` hydrates completed turns from the server's stored messages and their traces, and layers the streaming turn on top.
It lives in the layout, so switching views never interrupts a stream.

### The retrieval inspector
`components/retrieval/RetrievalTable.tsx` is the primary view: one row per candidate with its rank at each stage, which search found it, and whether it reached the prompt.
`components/retrieval/rows.ts` builds those rows by joining each stage's `candidates_out` with the packed context.
When the context event is missing (a reloaded session), it falls back to the assemble stage's output, which is exactly the kept chunks in marker order.
`components/retrieval/RankFlow.tsx` draws a bump chart between adjacent stages, offered behind a toggle only at five or more candidates (`MIN_CANDIDATES_FOR_FLOW`).
RankFlow knows nothing about specific stages; it reads `candidates_out` from any stage that has one.

### Self-explaining metadata
- `lib/stages.ts` gives every stage a short label, what it does, what its count means and why it might be slow, plus the latency thresholds.
- `lib/knobs.ts` gives every config knob its control type, hint, Learn link, and whether changing it needs a re-index.
- `lib/topics.ts` is the Learn content and maps stage names to topics for "explain" links.
- A knob whose machinery does not exist yet is listed with `implemented: false` (or a disabled option) and a "Not built yet" hint, never hidden and never faked.

## Tech
React, React Router, TanStack Query, react-markdown with remark-gfm, Tailwind CSS v4, Phosphor icons, Vite, Vitest, Playwright.

## Key files
- `web/src/app/App.tsx` - route map
- `web/src/app/Layout.tsx` - shell and outlet context
- `web/src/app/session.ts` - chat session hook and upload
- `web/src/lib/api.ts` - fetch client and SSE parser
- `web/src/lib/queries.ts` - query keys and hooks
- `web/src/lib/types.ts` - wire types mirroring the API
- `web/src/components/retrieval/` - stage strip, table, rank flow, citations
- `web/src/views/` - Chat, Library, Lab, Results, Learn

## Decisions and gotchas
- The table is primary and the chart secondary: on a small corpus every retriever returns everything and a chart draws flat lines, while a table still says what happened.
- The chart kit (`components/charts.tsx`) and RankFlow are hand-rolled SVG so the hairline, monochrome treatment stays exact.
- Results, Learn charts and knob hints import `evals/results/*.json` from the repo root, which is why `vite.config.ts` allows `..` in `server.fs`.
- Numbers quoted in `topics.ts` and `knobs.ts` prose are checked against the results files in CI.
- Citation markers the server did not validate stay literal text rather than becoming chips.
- A re-index is always an explicit button with its cost stated, never a side effect of changing a knob.

## Related
- [API](api.md)
- [UI design](ui-design.md)
- [Tracing](tracing.md)
- [Results files](results-files.md)
- [Testing](testing.md)
