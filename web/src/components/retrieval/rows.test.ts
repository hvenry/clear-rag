import { describe, expect, it } from "vitest";

import type { Candidate, ContextChunk, StageRecord } from "../../lib/types";
import { buildRows } from "./rows";

function candidate(chunk_id: string, rank: number): Candidate {
  return { chunk_id, score: 1 / rank, rank, source: "fuse", detail: {} };
}

function stage(name: string, out: Candidate[], into: Candidate[] | null = null): StageRecord {
  return {
    name,
    label: name,
    duration_ms: 1,
    config: {},
    diagnostics: {},
    candidates_in: into,
    candidates_out: out,
    error: null,
    degraded: false
  };
}

function chunk(chunk_id: string, marker: number): ContextChunk {
  return {
    marker,
    chunk_id,
    doc_id: "d1",
    filename: "resume.pdf",
    ordinal: marker - 1,
    text: `text of ${chunk_id}`,
    span: [marker * 1000, marker * 1000 + 500],
    page: null
  };
}

// Fusion ranked a, b, c; assembly kept a and c (b overlapped a) and numbered them 1, 2.
const fused = [candidate("a", 1), candidate("b", 2), candidate("c", 3)];
const stages = [stage("fuse", fused), stage("assemble", [fused[0], fused[2]], fused)];

describe("buildRows", () => {
  it("marks packed chunks from the streamed context", () => {
    const rows = buildRows(stages, [chunk("a", 1), chunk("c", 2)]);

    expect(rows.map((r) => [r.chunkId, r.marker])).toEqual([
      ["a", 1],
      ["b", null],
      ["c", 2]
    ]);
  });

  it("takes the keep-or-drop verdict from the assemble stage when no context streamed", () => {
    // A session reloaded from the server has its trace but no context event.
    const rows = buildRows(stages, []);

    expect(rows.map((r) => [r.chunkId, r.marker])).toEqual([
      ["a", 1],
      ["b", null],
      ["c", 2]
    ]);
  });
});
