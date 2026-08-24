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

export interface DocumentDetail {
  id: string;
  filename: string;
  text: string;
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
  config_hash: string;
  providers: {
    chat: { provider: string; model: string };
    embeddings: { provider: string; model: string };
  };
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
