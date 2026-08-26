import {
  BooksIcon,
  ChatCircleTextIcon,
  FlaskIcon,
  GraduationCapIcon
} from "@phosphor-icons/react";
import { NavLink, Outlet, useMatch } from "react-router-dom";

import { useConfig, useDocuments, useHealth } from "../lib/queries";
import { ConfigMenu } from "./ConfigMenu";
import { HealthBanner } from "./HealthBanner";
import { HealthMenu } from "./HealthMenu";
import { RuntimePanel } from "./RuntimePanel";
import { useAppUpload, useChatSession, type AppOutletContext } from "./session";
import { ThemeToggle } from "./ThemeToggle";

/**
 * The app shell: navigation, health, runtime and model controls in the header, the
 * routed view below, and the drop-anywhere upload overlay. Session state (the chat
 * conversation, in-flight uploads) lives here — above the routes — so switching
 * views never destroys it.
 */
export function Layout() {
  const { data: health } = useHealth();
  const { data: config } = useConfig();
  const { data: documents = [] } = useDocuments();
  // The active chat session follows the URL, but its state lives here — above the
  // routes — so navigating to the Library mid-stream never interrupts the answer.
  const chatMatch = useMatch("/chat/:sessionId");
  const session = useChatSession(chatMatch?.params.sessionId ?? null);
  const { upload, uploading, uploadProgress, dragging, dragHandlers } = useAppUpload();

  const context: AppOutletContext = { session, uploading, upload };

  return (
    <div className="flex h-full flex-col" {...dragHandlers}>
      <header className="glass-strong sticky top-0 z-20 border-x-0 border-t-0">
        <div className="flex items-center justify-between gap-2 px-3 py-2.5 sm:gap-4 sm:px-5 sm:py-3">
          <nav className="flex items-center gap-1">
            {(["chat", "library", "lab", "learn"] as const).map((v) => {
              const Icon = NAV_ICON[v];
              return (
                <NavLink
                  key={v}
                  to={`/${v}`}
                  className={({ isActive }) =>
                    [
                      "flex items-center gap-1.5 border px-2 py-1 font-display text-[10px] tracking-[0.12em] uppercase transition-colors sm:px-2.5 sm:tracking-[0.16em]",
                      isActive
                        ? "border-foreground/50 bg-foreground text-background"
                        : "border-line text-subtle hover:border-foreground/40 hover:text-foreground"
                    ].join(" ")
                  }
                >
                  {({ isActive }) => (
                    <>
                      <Icon size={12} weight={isActive ? "fill" : "regular"} />
                      <span className="hidden min-[540px]:inline">{v}</span>
                      {v === "library" && documents.length ? (
                        <span className="tabular opacity-60">{documents.length}</span>
                      ) : null}
                    </>
                  )}
                </NavLink>
              );
            })}
          </nav>
          <div className="flex items-center gap-3">
            <RuntimePanel />
            {config ? <ConfigMenu config={config} /> : null}
            <HealthMenu health={health ?? null} />
            <ThemeToggle />
          </div>
        </div>
        <HealthBanner health={health ?? null} />
      </header>

      <div className="flex min-h-0 flex-1 flex-col">
        <Outlet context={context} />
      </div>

      {/* Indexing toast: uploads run from any page (drag-drop, library, the chat
          dialog), so their progress lives above all of them. */}
      {uploadProgress ? (
        <div className="fixed right-4 bottom-4 z-50 w-64 border border-line bg-background py-2.5 pr-3 pl-3 shadow-[0_8px_28px_rgb(0_0_0/0.4)]">
          <p className="menu-label mb-1.5">Indexing</p>
          <div className="h-1 w-full bg-foreground/10">
            <div
              className="h-full bg-foreground transition-[width] duration-300"
              style={{
                width: `${Math.round((uploadProgress.index / uploadProgress.total) * 100)}%`
              }}
            />
          </div>
          <p className="tabular mt-1 truncate font-mono text-[10px] text-subtle">
            {uploadProgress.index + 1}/{uploadProgress.total} · {uploadProgress.filename}
          </p>
        </div>
      ) : null}

      {dragging ? (
        <div className="glass-strong pointer-events-none fixed inset-0 z-50 flex items-center justify-center">
          <div className="panel-ticks relative border border-foreground/40 px-10 py-8 text-center">
            <p className="font-display text-[14px] tracking-[0.2em] uppercase">Drop to index</p>
            <p className="mt-1.5 font-mono text-[10px] text-subtle">
              pdf · docx · md · csv · txt
            </p>
          </div>
        </div>
      ) : null}
    </div>
  );
}

const NAV_ICON = {
  chat: ChatCircleTextIcon,
  library: BooksIcon,
  lab: FlaskIcon,
  learn: GraduationCapIcon
} as const;

