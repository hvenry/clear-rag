import { Link } from "react-router-dom";

/**
 * An address that names nothing. Shown instead of silently redirecting, because a
 * mistyped or stale link that quietly lands on Chat looks like the app lost your
 * place — saying "this path doesn't exist" is the honest version.
 */
export function NotFound() {
  return (
    <div className="mx-auto max-w-md px-4 py-16">
      <h2 className="font-display text-[15px] tracking-[0.14em] uppercase">Nothing here</h2>
      <div className="rule-dashed my-4" />
      <p className="text-[13px] leading-relaxed text-muted">
        This address doesn't match any view. The app lives at{" "}
        <Link to="/chat" className="underline decoration-line underline-offset-2 hover:decoration-foreground">
          /chat
        </Link>
        ,{" "}
        <Link to="/library" className="underline decoration-line underline-offset-2 hover:decoration-foreground">
          /library
        </Link>
        ,{" "}
        <Link to="/lab" className="underline decoration-line underline-offset-2 hover:decoration-foreground">
          /lab
        </Link>{" "}
        and{" "}
        <Link to="/learn" className="underline decoration-line underline-offset-2 hover:decoration-foreground">
          /learn
        </Link>
        .
      </p>
    </div>
  );
}
