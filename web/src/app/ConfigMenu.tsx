import { InfoIcon } from "@phosphor-icons/react";
import { useRef, useState } from "react";

import { AnchoredPopover, useHoverMenu } from "../components/Popover";
import { headerControl } from "./headerControl";
import { KeyValueRow } from "../components/KeyValueRow";
import { Select } from "../components/Select";
import { useModels, useUpdateProviders } from "../lib/queries";
import type { ConfigResponse } from "../lib/types";

/**
 * The provider control in the header: an info glyph whose hover card names the
 * chat model, embedding model and config hash. Not just a readout: both models can be
 * switched here, from the list Ollama actually has installed. A chat switch is
 * free; an embedding switch is applied honestly: the menu warns that the stored
 * vectors become incomparable and the embedding-space guard will require a
 * re-index before the next query.
 */
export function ConfigMenu({ config }: { config: ConfigResponse }) {
  const menu = useHoverMenu();
  const triggerRef = useRef<HTMLButtonElement>(null);

  return (
    <div className="relative hidden md:block">
      <button
        ref={triggerRef}
        onClick={menu.toggle}
        {...menu.hover}
        aria-label="Models and configuration"
        className={headerControl(menu.open)}
      >
        <InfoIcon size={16} />
      </button>

      {menu.open ? (
        <AnchoredPopover
          anchorRef={triggerRef}
          onClose={menu.close}
          backdrop={false}
          {...menu.hover}
          className="w-[min(22rem,calc(100vw-2rem))] p-3"
        >
          <div className="mb-2 menu-label">Models</div>
          <dl className="mb-3 space-y-1">
            <KeyValueRow label="chat" value={config.providers.chat.model} />
            <KeyValueRow label="embeddings" value={config.providers.embeddings.model} />
            <KeyValueRow label="config hash" value={config.config_hash} />
          </dl>
          <ProviderForm config={config} />
          <p className="mt-2 border-t border-line pt-2 text-meta leading-relaxed text-muted">
            Config hash <span className="tabular font-mono">{config.config_hash}</span>{" "}
            fingerprints the exact retrieval settings. Every trace and every Lab run is
            stamped with the hash it ran under, so two results are comparable exactly
            when their hashes match.
          </p>
        </AnchoredPopover>
      ) : null}
    </div>
  );
}

function ProviderForm({ config }: { config: ConfigResponse }) {
  const { data } = useModels();
  const update = useUpdateProviders();
  const [chatModel, setChatModel] = useState(config.providers.chat.model);
  const [embedModel, setEmbedModel] = useState(config.providers.embeddings.model);
  const [notice, setNotice] = useState<string | null>(null);

  const dirty =
    chatModel !== config.providers.chat.model || embedModel !== config.providers.embeddings.model;
  const embedDirty = embedModel !== config.providers.embeddings.model;

  const apply = async () => {
    try {
      const patch: { chat_model?: string; embed_model?: string } = {};
      if (chatModel !== config.providers.chat.model) patch.chat_model = chatModel;
      if (embedDirty) patch.embed_model = embedModel;
      const response = await update.mutateAsync(patch);
      setNotice(
        response.reindex_needed
          ? "Embedding model switched. Re-index before the next query (Lab → re-index, or the health banner will walk you through it)."
          : "Applied."
      );
    } catch (error) {
      setNotice(String(error));
    }
  };

  return (
    <div className="space-y-2">
      <ModelField
        label={`chat model · ${config.providers.chat.provider}`}
        value={chatModel}
        models={data?.chat ?? []}
        onChange={setChatModel}
      />
      <ModelField
        label={`embedding model · ${config.providers.embeddings.provider}`}
        value={embedModel}
        models={data?.embedding ?? []}
        onChange={setEmbedModel}
      />

      {embedDirty ? (
        <p className="border-l-2 border-slow/60 pl-2 text-meta leading-relaxed text-muted">
          Vectors from different embedding models are not comparable, so applying this
          requires re-indexing every document before queries work again.
        </p>
      ) : null}

      <div className="flex items-center gap-2">
        <button
          onClick={() => void apply()}
          disabled={!dirty || update.isPending}
          className="border border-line px-2.5 py-1 font-display text-meta tracking-[0.14em] uppercase transition-colors hover:border-foreground/60 hover:bg-foreground hover:text-background disabled:pointer-events-none disabled:opacity-30"
        >
          {update.isPending ? "applying…" : "apply"}
        </button>
        {notice ? <p className="min-w-0 flex-1 text-meta text-subtle">{notice}</p> : null}
      </div>
    </div>
  );
}

/** A select when Ollama's installed models are known, a text input when they aren't. */
function ModelField({
  label,
  value,
  models,
  onChange
}: {
  label: string;
  value: string;
  models: string[];
  onChange: (value: string) => void;
}) {
  // The configured model may not be in Ollama's list (a bare tag like "llama3.2"
  // matches "llama3.2:latest" server-side), so keep it selectable rather than
  // silently snapping to something else.
  const options = models.includes(value) ? models : [value, ...models];

  return (
    <label className="block">
      <span className="mb-0.5 block font-mono text-meta text-subtle">{label}</span>
      {models.length > 0 ? (
        <Select value={value} options={options} onChange={onChange} />
      ) : (
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="w-full border border-line bg-transparent px-2 py-1 font-mono text-ui outline-none transition-colors focus:border-foreground/45"
        />
      )}
    </label>
  );
}
