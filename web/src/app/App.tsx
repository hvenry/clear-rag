import { Navigate, Route, Routes } from "react-router-dom";

import { ALL_TOPICS } from "../lib/topics";
import { ChatView } from "../views/chat/ChatView";
import { LabView } from "../views/lab/LabView";
import { LearnView } from "../views/learn/LearnView";
import { LibraryView } from "../views/library/LibraryView";
import { Layout } from "./Layout";
import { NotFound } from "./NotFound";

/**
 * Route map. Navigation is URL state — every view, document and topic is a
 * deep-linkable address, and the back button means what it says:
 *
 *   /chat                the conversation
 *   /library             document list · /library/map the embedding map
 *   /library/:docId      one document's chunks (citation spans arrive in
 *                        location.state — an ephemeral highlight is not an address)
 *   /lab                 side-by-side experiment runs
 *   /learn/:topicId      one concept page
 *
 * What deliberately does NOT live in the URL: the chat session. It belongs to the
 * layout above the routes, so navigating away and back never wipes a conversation.
 */
export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<Navigate to="/chat" replace />} />
        <Route path="/chat" element={<ChatView />} />
        <Route path="/chat/:sessionId" element={<ChatView />} />
        <Route path="/library" element={<LibraryView />} />
        <Route path="/library/map" element={<LibraryView />} />
        <Route path="/library/:docId" element={<LibraryView />} />
        <Route path="/lab" element={<LabView />} />
        <Route path="/learn" element={<Navigate to={`/learn/${ALL_TOPICS[0].id}`} replace />} />
        <Route path="/learn/:topicId" element={<LearnView />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}
