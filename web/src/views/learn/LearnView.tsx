import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";

import { MeterRow } from "../../components/charts";
import { PanelTrigger, SidePanel } from "../../components/SidePanel";
import { TOPIC_CHARTS } from "../../lib/benchmarks";
import { ALL_TOPICS, TOPIC_GROUPS, type Topic } from "../../lib/topics";

/**
 * The Learn section: one page per concept the app exhibits, written against this
 * project's real measurements. The hover hints answer "what is this number"; these
 * pages answer "why does this stage exist at all". Each topic is an address
 * (`/learn/:topicId`), so a concept page can be linked from anywhere, including
 * outside the app.
 */
export function LearnView() {
  const { topicId } = useParams<{ topicId?: string }>();
  const navigate = useNavigate();
  const onSelect = (id: string) => navigate(`/learn/${id}`);
  const topic = useMemo(
    () => ALL_TOPICS.find((t) => t.id === topicId) ?? ALL_TOPICS[0],
    [topicId]
  );
  const paneRef = useRef<HTMLDivElement>(null);
  const [tocOpen, setTocOpen] = useState(false);

  const pick = (id: string) => {
    onSelect(id);
    setTocOpen(false);
  };

  useEffect(() => {
    paneRef.current?.scrollTo({ top: 0 });
  }, [topic.id]);

  return (
    <div className="flex h-full min-h-0 flex-col lg:flex-row">
      <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-2 lg:hidden">
        <span className="min-w-0 truncate font-display text-body tracking-wide">
          {topic.title}
        </span>
        <PanelTrigger label="Topics" onOpen={() => setTocOpen(true)} />
      </div>

      <SidePanel title="Topics" open={tocOpen} onClose={() => setTocOpen(false)}>
        {TOPIC_GROUPS.map((group) => (
          <section key={group.title} className="pt-4">
            <h2 className="px-4 pb-1.5 font-display text-meta tracking-[0.18em] text-subtle uppercase">
              {group.title}
            </h2>
            <ul>
              {group.topics.map((t) => (
                <li key={t.id}>
                  <button
                    onClick={() => pick(t.id)}
                    className={[
                      "w-full border-l-2 px-4 py-1.5 text-left transition-colors",
                      topic.id === t.id
                        ? "border-l-foreground bg-foreground/6"
                        : "border-l-transparent hover:bg-foreground/4"
                    ].join(" ")}
                  >
                    <div className="text-body">{t.title}</div>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
        <div className="rule-dashed mx-4 my-4" />
        <p className="px-4 pb-5 text-meta leading-relaxed text-subtle">
          Every number quoted on these pages is a real measurement from the bundled
          benchmarks, reproducible with <Code text="clear-rag ablate" /> and{" "}
          <Code text="clear-rag eval" />.
        </p>
      </SidePanel>

      <div ref={paneRef} className="min-w-0 flex-1 overflow-y-auto">
        <TopicPage topic={topic} onSelect={pick} />
      </div>
    </div>
  );
}

function TopicPage({ topic, onSelect }: { topic: Topic; onSelect: (id: string) => void }) {
  const index = ALL_TOPICS.findIndex((t) => t.id === topic.id);
  const previous = ALL_TOPICS[index - 1];
  const next = ALL_TOPICS[index + 1];

  return (
    <article className="reveal mx-auto max-w-2xl px-4 py-6 sm:px-6 sm:py-8">
      <h1 className="font-display text-[22px] tracking-wide">{topic.title}</h1>
      <p className="mt-1 text-body text-subtle">{topic.summary}</p>
      <div className="rule-dashed my-5" />

      <div className="space-y-4">
        {topic.body.map((paragraph, i) => (
          <p key={i} className="text-body leading-[1.8] text-muted">
            <Rich text={paragraph} />
          </p>
        ))}
      </div>

      {topic.formula ? (
        <figure className="panel-ticks relative mt-6 border border-line px-4 py-3">
          <div className="mb-1.5 menu-label">Formula</div>
          <code className="block font-mono text-body leading-relaxed break-words">
            {topic.formula.text}
          </code>
          <figcaption className="mt-2 text-ui leading-relaxed text-subtle">
            {topic.formula.caption}
          </figcaption>
        </figure>
      ) : null}

      {(TOPIC_CHARTS[topic.id] ?? []).map((chart) => (
        <figure key={chart.title} className="mt-6 border border-line px-4 py-3">
          <div className="menu-label">{chart.title}</div>
          <div className="mt-2.5">
            {chart.rows.map((row) => (
              <MeterRow
                key={row.label}
                label={row.label}
                value={row.value.toFixed(3)}
                fraction={row.value / (chart.domain ?? Math.max(...chart.rows.map((r) => r.value)))}
                color={row.color}
                hint={row.hint}
                labelWidth="9.5rem"
              />
            ))}
          </div>
          <figcaption className="mt-2 text-ui leading-relaxed text-subtle">
            <Rich text={chart.note} /> Real measurements from the bundled benchmarks,
            reproducible with <Code text="clear-rag ablate" />.
          </figcaption>
        </figure>
      ))}

      {topic.seeIt ? (
        <aside className="mt-6 border-l-2 border-foreground/40 pl-3">
          <div className="menu-label">See it live</div>
          <p className="mt-1 text-body leading-relaxed text-muted">
            <Rich text={topic.seeIt} />
          </p>
        </aside>
      ) : null}

      <nav className="mt-10 flex items-center justify-between border-t border-line pt-4">
        {previous ? (
          <button
            onClick={() => onSelect(previous.id)}
            className="text-left font-mono text-ui text-subtle transition-colors hover:text-foreground"
          >
            ← {previous.title}
          </button>
        ) : (
          <span />
        )}
        {next ? (
          <button
            onClick={() => onSelect(next.id)}
            className="text-right font-mono text-ui text-subtle transition-colors hover:text-foreground"
          >
            {next.title} →
          </button>
        ) : (
          <span />
        )}
      </nav>
    </article>
  );
}

/** Renders `backticked` spans as inline code and `**bold**` as emphasis. */
function Rich({ text }: { text: string }) {
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g);
  return (
    <>
      {parts.map((part, i) =>
        part.startsWith("`") && part.endsWith("`") ? (
          <Code key={i} text={part.slice(1, -1)} />
        ) : part.startsWith("**") && part.endsWith("**") ? (
          <strong key={i} className="font-medium text-foreground">
            {part.slice(2, -2)}
          </strong>
        ) : (
          <span key={i}>{part}</span>
        )
      )}
    </>
  );
}

function Code({ text }: { text: string }) {
  return (
    <code className="border border-line bg-foreground/5 px-1 py-px font-mono text-[0.85em]">
      {text}
    </code>
  );
}
