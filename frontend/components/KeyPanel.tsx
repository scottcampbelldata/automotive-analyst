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
    <section className="card card-form space-y-4" aria-labelledby="key-title">
      <div>
        <div className="eyebrow mb-1">Bring your own key</div>
        <h2 id="key-title" className="section-title">Connect a model to run queries</h2>
        <p className="text-[0.95rem] text-mute mt-2 max-w-2xl">
          Pick a provider and paste an API key. It is stored only in this browser tab
          and sent <strong className="text-strong">directly</strong> to the provider,
          never to this site&apos;s server, and it is gone when you close the tab.
        </p>
      </div>

      <div className="flex gap-2">
        {PROVIDERS.map((p) => (
          <button
            key={p.id}
            onClick={() => pickProvider(p.id)}
            aria-pressed={provider === p.id}
            className={`provider flex-1 px-3 ${provider === p.id ? "is-on" : ""}`}
          >
            {p.label}
          </button>
        ))}
      </div>

      <div className="space-y-1.5">
        <label htmlFor="api-key" className="field-label">API key</label>
        <input
          id="api-key"
          type="password"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && save()}
          placeholder={provider === "gemini" ? "AIza..." : provider === "openai" ? "sk-..." : "sk-ant-..."}
          autoComplete="off"
          className="field mono"
        />
        <div className="text-sm text-mute">
          Need one?{" "}
          <a href={keysUrl} target="_blank" rel="noreferrer" className="text-accent underline">
            Get a {PROVIDERS.find((p) => p.id === provider)!.label} key &#8599;
          </a>
        </div>
      </div>

      <div className="space-y-1.5">
        <label htmlFor="model" className="field-label">Model</label>
        <input
          id="model"
          list={`models-${provider}`}
          aria-label="Model"
          value={model}
          onChange={(e) => setModel(e.target.value)}
          className="field mono"
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
          className="btn-primary px-5"
        >
          Save key
        </button>
        {onCancel && (
          <button
            onClick={onCancel}
            className="btn-quiet px-5"
          >
            Cancel
          </button>
        )}
      </div>
    </section>
  );
}
