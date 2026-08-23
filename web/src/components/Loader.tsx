export function Loader({ label }: { label?: string }) {
  return (
    <div className="flex items-center gap-2">
      <div className="flex gap-1">
        {[0, 1, 2].map((i) => (
          <span key={i} className="loader-dot" style={{ animationDelay: `${i * 0.15}s` }} />
        ))}
      </div>
      {label ? <span className="font-mono text-[10px] text-subtle">{label}</span> : null}
    </div>
  );
}
