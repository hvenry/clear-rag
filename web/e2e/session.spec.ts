import { expect, test, type Page } from "@playwright/test";

import type { Candidate, SessionDetail, StageRecord, Trace } from "../src/lib/types";

/**
 * Reopening a stored conversation: the server returns messages with their traces but
 * no streamed context, and the retrieval inspector must still say which chunks the
 * model saw. Shaped after a real `/api/sessions/{id}` response, with neutral text.
 */

const SESSION_ID = "s_fixture";

function candidate(chunk_id: string, rank: number, source: string): Candidate {
  return { chunk_id, score: 1 / rank, rank, source, detail: {} };
}

function stage(
  name: string,
  label: string,
  out: Candidate[] | null,
  into: Candidate[] | null = null
): StageRecord {
  return {
    name,
    label,
    duration_ms: 12,
    config: {},
    diagnostics: {},
    candidates_in: into,
    candidates_out: out,
    error: null,
    degraded: false
  };
}

const ids = ["c_kept_one", "c_overlapping", "c_kept_two"];
const ranked = (source: string) => ids.map((id, i) => candidate(id, i + 1, source));

// Assembly kept the first and third chunks; the second overlapped the first.
const trace: Trace = {
  id: "t_fixture",
  query: "what does the handbook say about leave?",
  resolved_query: "what does the handbook say about leave?",
  config_hash: "fixture",
  created_at: 1789010181,
  stages: [
    stage("dense", "Vector search", ranked("dense")),
    stage("bm25", "Keyword search", ranked("bm25")),
    stage("fuse", "Fuse rankings", ranked("fuse")),
    {
      ...stage(
        "assemble",
        "Assemble context",
        [ranked("fuse")[0], ranked("fuse")[2]],
        ranked("fuse")
      ),
      diagnostics: {
        chunks_used: 2,
        chunks_dropped: 1,
        dropped: [{ chunk_id: "c_overlapping", reason: "overlapping_span" }]
      }
    },
    stage("generate", "Generate answer", null)
  ],
  answer: "Staff accrue leave monthly [1] and may carry five days over [2].",
  citations: [
    {
      chunk_id: "c_kept_one",
      doc_id: "d_handbook",
      filename: "handbook.pdf",
      span: [0, 900],
      page: 1,
      quote: "Staff accrue leave monthly.",
      marker: 1
    },
    {
      chunk_id: "c_kept_two",
      doc_id: "d_handbook",
      filename: "handbook.pdf",
      span: [1600, 2400],
      page: 2,
      quote: "Up to five days may be carried over.",
      marker: 2
    }
  ],
  total_ms: 2400
};

const session: SessionDetail = {
  id: SESSION_ID,
  title: "leave policy",
  created_at: 1789010176,
  n_messages: 2,
  doc_ids: null,
  messages: [
    { role: "user", content: trace.query, trace_id: null, created_at: 1789010181, trace: null },
    { role: "assistant", content: trace.answer!, trace_id: trace.id, created_at: 1789010190, trace }
  ]
};

async function mockApi(page: Page) {
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    const reply = (body: unknown) => route.fulfill({ json: body });
    if (path === `/api/sessions/${SESSION_ID}`) return reply(session);
    if (path === "/api/sessions") return reply([{ ...session, messages: undefined }]);
    if (path === "/api/health") return reply({ ok: true, checks: [], documents: 1, chunks: 3 });
    if (path === "/api/documents" || path === "/api/traces") return reply([]);
    return route.fulfill({ status: 404, body: "not mocked" });
  });
}

test("a reopened session shows which chunks reached the model", async ({ page }) => {
  await mockApi(page);
  await page.goto(`/chat/${SESSION_ID}`);

  const row = (chunkId: string) => page.getByRole("row").filter({ hasText: chunkId });
  const inAnswer = (chunkId: string) => row(chunkId).getByRole("cell").last();

  await expect(page.getByText("Retrieval inspector")).toBeVisible();
  await expect(inAnswer("c_kept_one")).toHaveText("1");
  await expect(inAnswer("c_kept_two")).toHaveText("2");
  await expect(inAnswer("c_overlapping")).toHaveText("dropped");

  // A kept chunk's text is not stored with the trace, but it must not read as absent.
  await expect(row("c_kept_one")).not.toContainText("not in final context");
});
