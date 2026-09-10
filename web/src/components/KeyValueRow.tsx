/** One label · value line in a popover card or readout: mono, small, baseline-aligned. */
export function KeyValueRow({
  label,
  value,
  valueClassName = ""
}: {
  label: string;
  value: string;
  valueClassName?: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="font-mono text-meta text-subtle">{label}</dt>
      <dd className={`tabular truncate font-mono text-ui ${valueClassName}`}>{value}</dd>
    </div>
  );
}
