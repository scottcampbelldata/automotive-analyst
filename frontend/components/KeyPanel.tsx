"use client";
import { useState } from "react";
import {
  Creds,
  DEFAULT_MODEL,
  MODEL_SUGGESTIONS,
  PROVIDERS,
  Provider,
  saveCreds,
} from "@/lib/keyStore";

export function KeyPanel({
  initial,
  onSaved,
  onCancel,
}: {
  initial: Creds | null;
  onSaved: (c: Creds) => void;
  onCancel?: () => void;
}) {
  const [provider, setProvider] = useState<Provider>(initial?.provider ?? "anthropic");
  const [key, setKey] = useState(initial?.key ?? "");
  const [model, setModel] = useState(initial?.model ?? DEFAULT_MODEL["anthropic"]);

  function pickProvider(p: Provider) {
    setProvider(p);
    setModel(DEFAULT_MODEL[p]); // reset model to that provider's default
  }

  function save() {
    const trimmed = key.trim();
    if (!trimmed) return;
    const creds = { provider, key: trimmed, model: model.trim() || DEFAULT_MODEL[provider] };
    saveCreds(creds);
    onSaved(creds);
  }

  const keysUrl = PROVIDERS.find((p) => p.id === provider)!.keysUrl;

  return (
    <div className="card space-y-4">
      <div>
        <div className="eyebrow mb-1">Bring your own key</div>
        <div className="section-title">Connect a model to run queries</div>
        <p className="text-sm text-mute mt-1">
          Pick a provider and paste an API key. It's stored only in this browser tab
          and sent <strong className="text-white">directly</strong> to the provider -
          never to this site's server, and gone when you close the tab.
        </p>
      </div>

      <div className="flex gap-2">
        {PROVIDERS.map((p) => (
          <button
            key={p.id}
            onClick={() => pickProvider(p.id)}
            className={`flex-1 rounded-lg border px-3 py-2 text-sm transition-colors ${
              provider === p.id
                ? "border-accent text-white bg-[var(--panel-2)]"
                : "border-edge text-mute hover:text-white"
            }`}
          >
            {p.label}
          </button>
        ))}
      </div>

      <div className="space-y-1">
        <label className="text-xs text-faint uppercase tracking-wider">API key</label>
        <input
          type="password"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && save()}
          placeholder={provider === "gemini" ? "AIza…" : provider === "openai" ? "sk-…" : "sk-ant-…"}
          autoComplete="off"
          className="w-full bg-[var(--panel-2)] border border-edge rounded-lg px-4 py-2.5 text-sm text-white placeholder:text-faint outline-none focus:border-accent"
        />
        <div className="text-xs text-faint">
          Need one?{" "}
          <a href={keysUrl} target="_blank" rel="noreferrer" className="text-accent hover:underline">
            Get a {PROVIDERS.find((p) => p.id === provider)!.label} key ↗
          </a>
        </div>
      </div>

      <div className="space-y-1">
        <label className="text-xs text-faint uppercase tracking-wider">Model</label>
        <input
          list={`models-${provider}`}
          value={model}
          onChange={(e) => setModel(e.target.value)}
          className="w-full bg-[var(--panel-2)] border border-edge rounded-lg px-4 py-2.5 text-sm text-white outline-none focus:border-accent"
        />
        <datalist id={`models-${provider}`}>
          {MODEL_SUGGESTIONS[provider].map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
      </div>

      <div className="flex gap-2">
        <button
          onClick={save}
          disabled={!key.trim()}
          className="px-5 py-2.5 rounded-lg bg-accent text-white text-sm font-medium disabled:opacity-50"
        >
          Save key
        </button>
        {onCancel && (
          <button
            onClick={onCancel}
            className="px-5 py-2.5 rounded-lg border border-edge text-mute text-sm hover:text-white"
          >
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}
