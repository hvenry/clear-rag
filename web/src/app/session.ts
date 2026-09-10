import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";

import { api } from "../lib/api";
import { keys, useSessionDetail, useUpload } from "../lib/queries";
import { mergeStage } from "../lib/stages";
import type { SessionMessage, Turn } from "../lib/types";

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

/** Rebuild renderable turns from a session's stored messages. Assistant messages
 * carry their full trace, so stages, citations and the resolved query all come back
 * (only the ephemeral context-chunk previews are not reconstructed). */
function turnsFromMessages(messages: SessionMessage[]): Turn[] {
  const turns: Turn[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      turns.push({
        question: message.content,
        answer: "",
        citations: [],
        context: [],
        stages: [],
        trace: null,
        error: null,
        streaming: false
      });
    } else if (turns.length > 0) {
      const turn = turns[turns.length - 1];
      turn.answer = message.trace?.answer ?? message.content;
      turn.trace = message.trace;
      turn.citations = message.trace?.citations ?? [];
      turn.stages = message.trace?.stages ?? [];
    }
  }
  return turns;
}

/**
 * The chat session for one server-side conversation. Completed turns are the
 * server's (hydrated from stored messages and their traces); the turn currently
 * streaming is client state layered on top. The layout owns this hook so
 * navigating between views never interrupts a stream in progress.
 */
export function useChatSession(sessionId: string | null): ChatSession {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const client = useQueryClient();
  const { data: detail } = useSessionDetail(sessionId);
  const hydratedFor = useRef<string | null>(null);

  // Switching to a DIFFERENT session blanks the view and re-arms hydration; its
  // turns arrive with its detail. Leaving chat entirely (sessionId null) keeps
  // everything, because navigating to the Library and back must not wipe the
  // conversation, least of all one still streaming. Re-renders of the same
  // session never clobber local turns, which are newer than the server's.
  useEffect(() => {
    if (sessionId !== null && sessionId !== hydratedFor.current) {
      hydratedFor.current = null;
      setTurns([]);
    }
  }, [sessionId]);

  useEffect(() => {
    if (detail && detail.id !== hydratedFor.current) {
      hydratedFor.current = detail.id;
      setTurns(turnsFromMessages(detail.messages));
    }
  }, [detail]);

  const ask = useCallback(async () => {
    const text = question.trim();
    if (!text || busy || !sessionId) return;

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
      for await (const event of api.chat(text, history, sessionId)) {
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
      // The first question also titles the session, and the stored transcript grew.
      void client.invalidateQueries({ queryKey: keys.sessions });
    }
  }, [question, busy, turns, client, sessionId]);

  return { turns, question, setQuestion, ask, busy };
}

export interface UploadProgress {
  filename: string;
  index: number;
  total: number;
}

/** App-wide drag-and-drop upload: dropping a file anywhere indexes it. */
export function useAppUpload() {
  const uploadMutation = useUpload();
  const [uploading, setUploading] = useState<string | null>(null);
  // Files upload one at a time so this progress is real, not a guess: parsing
  // and embedding dominate, and they happen per file anyway.
  const [uploadProgress, setUploadProgress] = useState<UploadProgress | null>(null);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);

  const upload = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return;
      const rejected: { filename: string; message?: string }[] = [];
      try {
        for (const [index, file] of files.entries()) {
          setUploadProgress({ filename: file.name, index, total: files.length });
          const { results } = await uploadMutation.mutateAsync([file]);
          rejected.push(
            ...results.filter((r) => r.status !== "indexed" && r.status !== "unchanged")
          );
        }
        setUploading(
          rejected.length ? rejected.map((r) => `${r.filename}: ${r.message}`).join(" · ") : null
        );
        if (rejected.length) setTimeout(() => setUploading(null), 6000);
      } catch (error) {
        setUploading(String(error));
        setTimeout(() => setUploading(null), 6000);
      } finally {
        setUploadProgress(null);
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

  return { upload, uploading, uploadProgress, dragging, dragHandlers };
}
