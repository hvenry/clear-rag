import type {
  ConfigResponse,
  DocumentDetail,
  DocumentSummary,
  Health,
  StreamEvent
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

export const api = {
  health: () => json<Health>("/health"),
  config: () => json<ConfigResponse>("/config"),
  updateConfig: (patch: Record<string, unknown>) =>
    json<{ config: Record<string, unknown>; config_hash: string; reindex_needed: boolean }>(
      "/config",
      { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) }
    ),
  reindex: () =>
    json<{ status: string; total_chunks: number; duration_ms: number }>("/reindex", {
      method: "POST"
    }),
  loadSample: () =>
    json<{ indexed: number; unchanged: number }>("/documents/sample", { method: "POST" }),

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

  /**
   * Stream a question. Yields each event as it arrives.
   *
   * Hand-rolled SSE parsing rather than `EventSource`, because the browser's built-in
   * only issues GET requests and the question plus conversation history belong in a body.
   */
  async *chat(
    question: string,
    history: { role: string; content: string }[],
    signal?: AbortSignal
  ): AsyncGenerator<StreamEvent> {
    const response = await fetch(`${BASE}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question, history }),
      signal
    });

    if (!response.ok || !response.body) {
      yield { type: "error", message: `Server returned ${response.status}.` };
      return;
    }

    const reader = response.body.getReader();
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
          yield JSON.parse(line.slice(6)) as StreamEvent;
        } catch {
          // A malformed frame should not kill an otherwise healthy stream.
        }
      }
    }
  }
};
