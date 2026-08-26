import type {
  ConfigResponse,
  DocumentDetail,
  DocumentSummary,
  Health,
  ImportEvent,
  ReindexEvent,
  RuntimeStatus,
  SampleSet,
  SessionDetail,
  SessionSummary,
  StreamEvent,
  TraceSummary
} from "./types";

const BASE = "/api";

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${BASE}${path}`, init);
  if (!response.ok) {
    const body = await response.text();
    throw new Error(body || `${response.status} ${response.statusText}`);
  }
  return response.json() as Promise<T>;
}

/**
 * Parse an SSE body into events as they arrive.
 *
 * Hand-rolled rather than `EventSource`, because the browser's built-in only issues
 * GET requests — chat needs a body, and the sample import is a POST.
 */
async function* sseEvents<T>(response: Response): AsyncGenerator<T> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // Events are separated by a blank line; a partial tail stays buffered.
    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";
    for (const part of parts) {
      const line = part.trim();
      if (!line.startsWith("data: ")) continue;
      try {
        yield JSON.parse(line.slice(6)) as T;
      } catch {
        // A malformed frame should not kill an otherwise healthy stream.
      }
    }
  }
}

export const api = {
  health: () => json<Health>("/health"),
  runtime: () => json<RuntimeStatus>("/runtime"),
  config: () => json<ConfigResponse>("/config"),
  updateConfig: (patch: Record<string, unknown>) =>
    json<{ config: Record<string, unknown>; config_hash: string; reindex_needed: boolean }>(
      "/config",
      { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) }
    ),
  models: () => json<{ chat: string[]; embedding: string[] }>("/models"),
  updateProviders: (patch: { chat_model?: string; embed_model?: string }) =>
    json<{
      providers: {
        chat: { provider: string; model: string };
        embeddings: { provider: string; model: string };
      };
      reindex_needed: boolean;
    }>("/providers", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch)
    }),
  /** Re-index the corpus, yielding per-document progress for the Lab's bar. */
  async *reindexStream(): AsyncGenerator<ReindexEvent> {
    const response = await fetch(`${BASE}/reindex/stream`, { method: "POST" });
    if (!response.ok || !response.body) {
      throw new Error((await response.text()) || `${response.status} ${response.statusText}`);
    }
    yield* sseEvents<ReindexEvent>(response);
  },

  sessions: () => json<SessionSummary[]>("/sessions"),
  session: (id: string) => json<SessionDetail>(`/sessions/${id}`),
  createSession: (body: { title?: string; doc_ids?: string[] | null }) =>
    json<SessionSummary>("/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    }),
  updateSession: (
    id: string,
    body: { title?: string; doc_ids?: string[]; all_documents?: boolean }
  ) =>
    json<SessionSummary>(`/sessions/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    }),
  deleteSession: (id: string) =>
    json<{ deleted: string }>(`/sessions/${id}`, { method: "DELETE" }),

  sampleSets: () => json<SampleSet[]>("/samples"),
  removeSampleSet: (id: string) =>
    json<{ removed: number; chunks_removed: number }>(`/samples/${id}`, { method: "DELETE" }),
  clearDocuments: () =>
    json<{ removed: number; chunks_removed: number }>("/documents", { method: "DELETE" }),

  /** Ingest a sample set, yielding per-file progress for the indexing bar. */
  async *importSampleSet(id: string, signal?: AbortSignal): AsyncGenerator<ImportEvent> {
    const response = await fetch(`${BASE}/samples/${id}`, { method: "POST", signal });
    if (!response.ok || !response.body) {
      throw new Error((await response.text()) || `${response.status} ${response.statusText}`);
    }
    yield* sseEvents<ImportEvent>(response);
  },

  traces: (limit = 30, sessionId?: string) =>
    json<TraceSummary[]>(
      `/traces?limit=${limit}${sessionId ? `&session_id=${encodeURIComponent(sessionId)}` : ""}`
    ),

  documents: () => json<DocumentSummary[]>("/documents"),
  document: (id: string) => json<DocumentDetail>(`/documents/${id}`),
  deleteDocument: (id: string) =>
    json<{ deleted: string; chunks_removed: number }>(`/documents/${id}`, { method: "DELETE" }),

  upload: (files: File[]) => {
    const form = new FormData();
    files.forEach((file) => form.append("files", file));
    return json<{ results: { status: string; filename: string; message?: string; chunks?: number }[] }>(
      "/documents",
      { method: "POST", body: form }
    );
  },

  /** Stream a question. Yields each event as it arrives. */
  async *chat(
    question: string,
    history: { role: string; content: string }[],
    sessionId: string | null = null,
    signal?: AbortSignal
  ): AsyncGenerator<StreamEvent> {
    const response = await fetch(`${BASE}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question, history, session_id: sessionId }),
      signal
    });

    if (!response.ok || !response.body) {
      yield { type: "error", message: `Server returned ${response.status}.` };
      return;
    }
    yield* sseEvents<StreamEvent>(response);
  }
};
