import { useNavigate } from "react-router-dom";

import { STAGE_TOPIC } from "../lib/topics";
import type { Citation } from "../lib/types";

/**
 * The two cross-view jumps every answer-bearing view needs. Chat and the Lab each
 * carried private copies of these handlers; the destinations are app-level facts
 * (a citation lives in the Library, an explanation in Learn), so the hooks live here.
 */

/** Open a citation's source document with the cited span highlighted. */
export function useOpenCitation() {
  const navigate = useNavigate();
  return (citation: Citation) =>
    navigate(`/library/${citation.doc_id}`, { state: { span: citation.span } });
}

/** Jump from a pipeline stage chip to the Learn page explaining it. */
export function useExplainStage() {
  const navigate = useNavigate();
  return (stageName: string) => {
    const topic = STAGE_TOPIC[stageName];
    if (topic) navigate(`/learn/${topic}`);
  };
}
