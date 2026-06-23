// Bring-your-own-key storage. The visitor's API key lives ONLY in this browser
// tab's sessionStorage - it is wiped when the tab closes, never persisted to
// disk, and never sent to this site's backend. It goes directly to the chosen
// LLM provider from the browser.

export type Provider = "anthropic" | "openai" | "gemini";

export interface Creds {
  provider: Provider;
  key: string;
  model: string;
}

export const PROVIDERS: { id: Provider; label: string; keysUrl: string }[] = [
  { id: "anthropic", label: "Claude", keysUrl: "https://console.anthropic.com/settings/keys" },
  { id: "openai", label: "OpenAI", keysUrl: "https://platform.openai.com/api-keys" },
  { id: "gemini", label: "Gemini", keysUrl: "https://aistudio.google.com/app/apikey" },
];

export const DEFAULT_MODEL: Record<Provider, string> = {
  anthropic: "claude-sonnet-4-6",
  openai: "gpt-5.4-mini",
  gemini: "gemini-3.5-flash",
};

// Suggestions shown in the model picker; the field stays free-text so a visitor
// can use whatever model their key has access to. Text/chat + reasoning models
// only - no image, audio/voice, video, or embedding models. Pulled from each
// provider's live model docs (June 2026), not guessed.
export const MODEL_SUGGESTIONS: Record<Provider, string[]> = {
  anthropic: [
    "claude-opus-4-8",
    "claude-fable-5",
    "claude-sonnet-4-6",
    "claude-haiku-4-5",
    "claude-opus-4-7",
    "claude-opus-4-6",
    "claude-opus-4-5",
    "claude-sonnet-4-5",
    "claude-opus-4-1",
  ],
  openai: [
    "gpt-5.5",
    "gpt-5.5-pro",
    "gpt-5.4",
    "gpt-5.4-pro",
    "gpt-5.4-mini",
    "gpt-5.4-nano",
    "gpt-5.3-codex",
    "gpt-5.2",
    "gpt-5.2-pro",
    "gpt-5.1",
    "gpt-5",
    "gpt-5-pro",
    "gpt-5-mini",
    "gpt-5-nano",
    "o3-pro",
    "o3",
    "gpt-4.1",
    "gpt-4.1-mini",
    "gpt-4o-mini",
  ],
  gemini: [
    "gemini-3.5-flash",
    "gemini-3.1-pro-preview",
    "gemini-3.1-flash-lite",
    "gemini-3-flash-preview",
    "gemini-2.5-pro",
    "gemini-2.5-flash",
    "gemini-2.5-flash-lite",
  ],
};

const STORAGE_KEY = "analyst.creds";

export function loadCreds(): Creds | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const c = JSON.parse(raw) as Creds;
    return c.provider && c.key ? c : null;
  } catch {
    return null;
  }
}

export function saveCreds(c: Creds): void {
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify(c));
}

export function clearCreds(): void {
  sessionStorage.removeItem(STORAGE_KEY);
}
