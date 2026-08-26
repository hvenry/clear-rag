/**
 * Server state, as TanStack Query hooks.
 *
 * The dividing line this module draws: data the *server* owns (health, config,
 * documents, traces) lives in the query cache and is refreshed by invalidation;
 * data the *client* owns (a streaming conversation, Lab run cards, a draft config)
 * stays in component state. Mutations name what they invalidate, which replaces the
 * old `refresh()` / `onCorpusChanged()` callbacks that had to be threaded through
 * every view by hand.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "./api";

export const keys = {
  health: ["health"] as const,
  config: ["config"] as const,
  documents: ["documents"] as const,
  document: (id: string) => ["documents", id] as const,
  samples: ["samples"] as const,
  sessions: ["sessions"] as const,
  session: (id: string) => ["sessions", id] as const,
  traces: ["traces"] as const
};

export function useHealth() {
  return useQuery({ queryKey: keys.health, queryFn: api.health, staleTime: 15_000 });
}

export function useConfig() {
  return useQuery({ queryKey: keys.config, queryFn: api.config, staleTime: 15_000 });
}

export function useDocuments() {
  return useQuery({ queryKey: keys.documents, queryFn: api.documents, staleTime: 30_000 });
}

export function useDocument(id: string | null) {
  return useQuery({
    queryKey: keys.document(id ?? ""),
    queryFn: () => api.document(id!),
    enabled: id !== null
  });
}

/** Everything that changes when the corpus does: listings, chunk counts, details. */
export function useInvalidateCorpus() {
  const client = useQueryClient();
  return () =>
    Promise.all([
      client.invalidateQueries({ queryKey: keys.documents }),
      client.invalidateQueries({ queryKey: keys.health }),
      client.invalidateQueries({ queryKey: keys.samples }),
      client.invalidateQueries({ queryKey: keys.traces })
    ]);
}

export function useSessions() {
  return useQuery({ queryKey: keys.sessions, queryFn: api.sessions, staleTime: 15_000 });
}

export function useSessionDetail(id: string | null) {
  return useQuery({
    queryKey: keys.session(id ?? ""),
    queryFn: () => api.session(id!),
    enabled: id !== null
  });
}

export function useCreateSession() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: api.createSession,
    onSettled: () => void client.invalidateQueries({ queryKey: keys.sessions })
  });
}

export function useUpdateSession() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      ...body
    }: {
      id: string;
      title?: string;
      doc_ids?: string[];
      all_documents?: boolean;
    }) => api.updateSession(id, body),
    onSettled: () => void client.invalidateQueries({ queryKey: keys.sessions })
  });
}

export function useDeleteSession() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: api.deleteSession,
    onSettled: () => void client.invalidateQueries({ queryKey: keys.sessions })
  });
}

export function useSampleSets() {
  return useQuery({ queryKey: keys.samples, queryFn: api.sampleSets, staleTime: 30_000 });
}

export function useRemoveSampleSet() {
  const invalidate = useInvalidateCorpus();
  return useMutation({
    mutationFn: api.removeSampleSet,
    onSettled: () => void invalidate()
  });
}

export function useClearDocuments() {
  const invalidate = useInvalidateCorpus();
  return useMutation({
    mutationFn: api.clearDocuments,
    onSettled: () => void invalidate()
  });
}

export function useUpload() {
  const invalidate = useInvalidateCorpus();
  return useMutation({
    mutationFn: api.upload,
    onSettled: () => void invalidate()
  });
}

export function useDeleteDocument() {
  const invalidate = useInvalidateCorpus();
  return useMutation({
    mutationFn: api.deleteDocument,
    onSettled: () => void invalidate()
  });
}

export function useUpdateConfig() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: api.updateConfig,
    onSettled: () => void client.invalidateQueries({ queryKey: keys.config })
  });
}

export function useModels() {
  return useQuery({ queryKey: ["models"], queryFn: api.models, staleTime: 60_000 });
}

export function useUpdateProviders() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: api.updateProviders,
    // A model switch changes what /config reports and what health checks — and an
    // embedding switch trips the index guard, which health is how the UI learns.
    onSettled: () =>
      void Promise.all([
        client.invalidateQueries({ queryKey: keys.config }),
        client.invalidateQueries({ queryKey: keys.health })
      ])
  });
}
