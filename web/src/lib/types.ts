/** Mirrors the dataclasses in `clearrag.core`. */

export interface Candidate {
  chunk_id: string;
  score: number;
  rank: number;
  source: string;
  detail: Record<string, unknown>;
}

export interface StageRecord {
  name: string;
  label: string;
  duration_ms: number;
  config: Record<string, unknown>;
  diagnostics: Record<string, unknown>;
  /** Non-null only on retrieval stages — the signal that a stage joins the rank flow. */
  candidates_in: Candidate[] | null;
  candidates_out: Candidate[] | null;
  error: string | null;
  degraded: boolean;
}

export interface Citation {
  chunk_id: string;
  doc_id: string;
  filename: string;
  span: [number, number];
  page: number | null;
  quote: string;
  marker: number;
}

export interface Trace {
  id: string;
  query: string;
  resolved_query: string | null;
  config_hash: string;
  created_at: number;
  stages: StageRecord[];
  answer: string | null;
  citations: Citation[];
  total_ms: number;
}

/** One row of /api/traces — enough per-stage detail to chart, without payloads. */
export interface TraceSummary {
  id: string;
  query: string;
  config_hash: string;
  created_at: number;
  total_ms: number;
  stages: { name: string; label: string; duration_ms: number }[];
  ttft_ms: number | null;
  tokens: number | null;
  tokens_per_second: number | null;
  n_citations: number;
}

export interface ContextChunk {
  marker: number;
  chunk_id: string;
  doc_id: string;
  filename: string;
  /** Position within its document, 0-based. */
  ordinal: number;
  text: string;
  span: [number, number];
  page: number | null;
}

export type StreamEvent =
  | { type: "stage"; stage: StageRecord }
  | { type: "context"; chunks: ContextChunk[] }
  | { type: "token"; text: string }
  | { type: "done"; trace: Trace }
  | { type: "error"; message: string; remedy?: string | null };

export interface DocumentSummary {
  id: string;
  filename: string;
  content_hash: string;
  created_at: number;
  chars: number;
  n_chunks: number;
}

/** A bundled demo corpus, with how much of it is already in the index. */
export interface SampleSet {
  id: string;
  label: string;
  description: string;
  file_count: number;
  indexed_count: number;
}

/** Per-document progress from a streaming re-index. */
export type ReindexEvent =
  | { type: "start"; filenames: string[] }
  | { type: "doc"; filename: string; index: number; total: number }
  | {
      type: "done";
      total_chunks: number;
      duration_ms: number;
      note?: string;
    }
  | { type: "error"; message: string; remedy?: string | null };

/** Per-file progress from a streaming sample-set import. */
export type ImportEvent =
  | { type: "start"; filenames: string[] }
  | { type: "file"; filename: string; index: number; total: number }
  | { type: "warning"; message: string }
  | { type: "done"; indexed: number; unchanged: number }
  | { type: "error"; message: string; remedy?: string | null };

export interface DocumentDetail {
  id: string;
  filename: string;
  text: string;
  /** Unix seconds when the document was first ingested. */
  created_at: number | null;
  meta: Record<string, unknown>;
  /** Parse structure over `text`: what the parser recovered before chunking. */
  blocks: {
    kind: "heading" | "paragraph" | "table";
    span: [number, number];
    level: number;
    page: number | null;
  }[];
  chunks: {
    id: string;
    ordinal: number;
    span: [number, number];
    page: number | null;
    text: string;
    context: string | null;
  }[];
}

export interface HealthCheck {
  component: string;
  provider?: string;
  model?: string | null;
  ok: boolean;
  /** A failing optional component degrades quality; it does not stop queries. */
  optional?: boolean;
  error?: string;
  remedy?: string | null;
}

export interface Health {
  ok: boolean;
  checks: HealthCheck[];
  documents?: number;
  chunks?: number;
}

export interface ConfigResponse {
  config: Record<string, unknown>;
  /** The pipeline's out-of-the-box values — what "reset defaults" restores. */
  defaults: Record<string, unknown>;
  config_hash: string;
  providers: {
    chat: { provider: string; model: string };
    embeddings: { provider: string; model: string };
  };
}

/** A persisted conversation. `doc_ids` null = the whole corpus, future docs included. */
export interface SessionSummary {
  id: string;
  title: string;
  created_at: number;
  n_messages: number;
  doc_ids: string[] | null;
}

export interface SessionMessage {
  role: "user" | "assistant";
  content: string;
  trace_id: string | null;
  created_at: number;
  /** Full trace for assistant messages — restores stages and citations on reload. */
  trace: Trace | null;
}

export interface SessionDetail extends SessionSummary {
  messages: SessionMessage[];
}

export interface Turn {
  question: string;
  answer: string;
  citations: Citation[];
  context: ContextChunk[];
  stages: StageRecord[];
  trace: Trace | null;
  error: { message: string; remedy?: string | null } | null;
  streaming: boolean;
}

/** Mirrors `clearrag.providers.runtime`. A readout of the local inference runtime. */
export interface ResidentModel {
  name: string;
  size_bytes: number;
  vram_bytes: number;
  /** Below 100 means Ollama split the model and part of it runs on the CPU. */
  on_gpu_pct: number;
  context_length: number | null;
  parameters: string | null;
  quantization: string | null;
  expires_at: string | null;
}

export interface RuntimeStatus {
  available: boolean;
  error?: string;
  models: ResidentModel[];
  resident_bytes: number;
  vram_bytes: number;
  fully_on_gpu: boolean;
}
