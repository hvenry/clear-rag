import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useRef, useState } from "react";

import { api } from "../lib/api";
import { keys, useUpload } from "../lib/queries";
import { mergeStage } from "../lib/stages";
import type { Turn } from "../lib/types";

/** What the layout shares with its routed views, via the router's outlet context. */
export interface AppOutletContext {
  session: ChatSession;
  uploading: string | null;
  upload: (files: File[]) => Promise<void>;
}

export interface ChatSession {
  turns: Turn[];
  question: string;
  setQuestion: (value: string) => void;
  ask: () => Promise<void>;
  busy: boolean;
}

/**
 * The chat session: client-owned state, deliberately outside both the URL and the
 * query cache. Streaming answers are neither an address nor server state — they are
 * a conversation in progress, and they live exactly as long as the tab does. The
 * layout owns this hook so navigating between views never unmounts the session.
 */
export function useChatSession(): ChatSession {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const client = useQueryClient();

  const ask = useCallback(async () => {
    const text = question.trim();
    if (!text || busy) return;

    setQuestion("");
    setBusy(true);

    const history = turns.flatMap((t) =>
      t.answer
        ? [
            { role: "user", content: t.question },
            { role: "assistant", content: t.answer }
          ]
        : []
    );

    const index = turns.length;
    setTurns((prev) => [
      ...prev,
      {
        question: text,
        answer: "",
        citations: [],
        context: [],
        stages: [],
        trace: null,
        error: null,
        streaming: true
      }
    ]);

    const patch = (fn: (turn: Turn) => Turn) =>
      setTurns((prev) => prev.map((t, i) => (i === index ? fn(t) : t)));

    try {
      for await (const event of api.chat(text, history)) {
        switch (event.type) {
          case "stage":
            patch((t) => ({ ...t, stages: mergeStage(t.stages, event.stage) }));
            break;
          case "context":
            patch((t) => ({ ...t, context: event.chunks }));
            break;
          case "token":
            patch((t) => ({ ...t, answer: t.answer + event.text }));
            break;
          case "done":
            patch((t) => ({
              ...t,
              trace: event.trace,
              citations: event.trace.citations,
              answer: event.trace.answer ?? t.answer,
              streaming: false
            }));
            break;
          case "error":
            patch((t) => ({
              ...t,
              error: { message: event.message, remedy: event.remedy },
              streaming: false
            }));
            break;
        }
      }
    } catch (error) {
      patch((t) => ({ ...t, error: { message: String(error) }, streaming: false }));
    } finally {
      patch((t) => ({ ...t, streaming: false }));
      setBusy(false);
      void client.invalidateQueries({ queryKey: keys.traces });
    }
  }, [question, busy, turns, client]);

  return { turns, question, setQuestion, ask, busy };
}

/** App-wide drag-and-drop upload: dropping a file anywhere indexes it. */
export function useAppUpload() {
  const uploadMutation = useUpload();
  const [uploading, setUploading] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);

  const upload = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return;
      setUploading(`Indexing ${files.length} file${files.length > 1 ? "s" : ""}…`);
      try {
        const { results } = await uploadMutation.mutateAsync(files);
        const rejected = results.filter(
          (r) => r.status !== "indexed" && r.status !== "unchanged"
        );
        setUploading(
          rejected.length ? rejected.map((r) => `${r.filename}: ${r.message}`).join(" · ") : null
        );
        if (rejected.length) setTimeout(() => setUploading(null), 6000);
      } catch (error) {
        setUploading(String(error));
        setTimeout(() => setUploading(null), 6000);
      }
    },
    [uploadMutation]
  );

  // Drag events fire for every nested element, so depth counting is what keeps the
  // overlay from flickering as the cursor crosses child boundaries.
  const dragHandlers = {
    onDragEnter: (e: React.DragEvent) => {
      e.preventDefault();
      dragDepth.current += 1;
      if (e.dataTransfer.types.includes("Files")) setDragging(true);
    },
    onDragOver: (e: React.DragEvent) => e.preventDefault(),
    onDragLeave: (e: React.DragEvent) => {
      e.preventDefault();
      dragDepth.current -= 1;
      if (dragDepth.current <= 0) setDragging(false);
    },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      dragDepth.current = 0;
      setDragging(false);
      void upload(Array.from(e.dataTransfer.files));
    }
  };

  return { upload, uploading, dragging, dragHandlers };
}
