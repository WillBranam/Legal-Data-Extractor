/**
 * Transport for the local text and vision models.
 *
 * Two providers are supported and both must stay loopback-only:
 *
 *   ollama  — Ollama's native API (/api/tags, /api/chat, /api/generate).
 *   openai  — an OpenAI-compatible server such as oMLX
 *             (/v1/models, /v1/chat/completions), optionally API-key protected.
 *
 * The rest of the codebase talks to this module, never to a provider's wire
 * format, so extraction logic is identical on both.
 */

export type LocalModelProvider = "ollama" | "openai";

const DEFAULT_BASE_URLS: Record<LocalModelProvider, string> = {
  ollama: "http://127.0.0.1:11434",
  openai: "http://127.0.0.1:8000"
};

// oMLX is the default host: it is measurably faster on Apple Silicon, so the
// appliance should not silently fall back to Ollama when .env.local is absent.
const DEFAULT_PROVIDER: LocalModelProvider = "openai";

const DEFAULT_MODELS: Record<LocalModelProvider, string> = {
  ollama: "qwen3:8b",
  openai: "Qwen3-8B-4bit"
};

const DEFAULT_VISUAL_MODELS: Record<LocalModelProvider, string> = {
  ollama: "qwen3-vl:8b",
  openai: "Qwen3-VL-8B-Instruct-4bit"
};
// A flat request timeout cannot hold. The extraction budget is 2,688 output
// tokens and a 4-bit 8B model on Apple Silicon sustains roughly 20-25 tokens
// per second, so a span that spends its whole budget needs over two minutes of
// generation alone. The old flat 120s cap aborted exactly those spans and
// reported a healthy model as unavailable. Derive the allowance from the token
// budget instead, so the two can never drift apart again.
const MIN_EXPECTED_TOKENS_PER_SECOND = 12;
const MODEL_REQUEST_OVERHEAD_MS = 30_000;
const MODEL_TIMEOUT_CEILING_MS = 600_000;
const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "[::1]"];

/**
 * Wall-clock allowance for one model request generating up to `maxTokens`.
 * The floor rate is deliberately pessimistic: a machine under memory pressure,
 * or one that has just swapped models, generates well below its warm rate.
 */
export function modelTimeoutForTokens(maxTokens: number): number {
  const generationMs = (Math.max(1, maxTokens) / MIN_EXPECTED_TOKENS_PER_SECOND) * 1000;
  return Math.min(
    MODEL_TIMEOUT_CEILING_MS,
    Math.round(MODEL_REQUEST_OVERHEAD_MS + generationMs)
  );
}

export function localModelProvider(
  value = process.env.LOCAL_LLM_PROVIDER?.trim().toLowerCase() || DEFAULT_PROVIDER
): LocalModelProvider {
  if (value !== "ollama" && value !== "openai") {
    throw new Error("LOCAL_MODEL_PROVIDER_INVALID");
  }
  return value;
}

export function validatedLocalModelEndpoint(
  value = process.env.LOCAL_LLM_BASE_URL ?? DEFAULT_BASE_URLS[localModelProvider()]
): URL {
  const url = new URL(value);
  // The appliance must never reach a model over a routable interface, whichever
  // provider is hosting it.
  if (url.protocol !== "http:" || !LOOPBACK_HOSTS.includes(url.hostname)) {
    throw new Error("LOCAL_MODEL_MUST_USE_LOOPBACK");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("INVALID_LOCAL_MODEL_URL");
  }
  return url;
}

export function validatedLocalModelName(
  value = process.env.LOCAL_LLM_MODEL?.trim() || DEFAULT_MODELS[localModelProvider()]
): string {
  // Ollama uses name:tag; MLX servers use a directory basename, which may
  // include a vendor prefix such as mlx-community/Qwen3-8B-4bit.
  if (
    !/^[a-zA-Z0-9][a-zA-Z0-9._/:+-]{0,127}$/.test(value) ||
    value.includes("://") ||
    value.toLowerCase().includes("cloud")
  ) {
    throw new Error("LOCAL_MODEL_NAME_REQUIRED");
  }
  return value;
}

export function validatedLocalVisualModelName(
  value = process.env.LOCAL_VISION_MODEL?.trim() || DEFAULT_VISUAL_MODELS[localModelProvider()]
): string {
  if (
    !/^[a-zA-Z0-9][a-zA-Z0-9._/:+-]{0,127}$/.test(value) ||
    value.includes("://") ||
    value.toLowerCase().includes("cloud")
  ) {
    throw new Error("LOCAL_VISUAL_MODEL_NAME_REQUIRED");
  }
  return value;
}

function apiKey(): string {
  return process.env.LOCAL_LLM_API_KEY?.trim() ?? "";
}

export async function localModelFetch(
  pathname: string,
  init?: RequestInit,
  timeoutMs = MODEL_TIMEOUT_CEILING_MS
): Promise<Response> {
  const url = validatedLocalModelEndpoint();
  url.pathname = pathname;
  const key = apiKey();
  return fetch(url, {
    ...init,
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.timeout(Math.max(1, Math.min(MODEL_TIMEOUT_CEILING_MS, timeoutMs))),
    headers: {
      "Content-Type": "application/json",
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
      ...(init?.headers ?? {})
    }
  });
}

/**
 * Installed model identifiers, normalized across providers. Ollama reports
 * `models[].name`; OpenAI-compatible servers report `data[].id`.
 */
export async function listInstalledModelNames(): Promise<string[]> {
  const provider = localModelProvider();
  const response = await localModelFetch(provider === "ollama" ? "/api/tags" : "/v1/models");
  if (!response.ok) throw new Error("LOCAL_MODEL_UNAVAILABLE");
  const body = (await response.json()) as {
    models?: Array<{ name?: string; model?: string }>;
    data?: Array<{ id?: string }>;
  };
  if (provider === "ollama") {
    return (body.models ?? []).flatMap((item) => {
      const name = item.name ?? item.model;
      return name ? [name] : [];
    });
  }
  return (body.data ?? []).flatMap((item) => (item.id ? [item.id] : []));
}

export function isConfiguredLocalModelInstalled(
  models: Array<{ name?: string; model?: string; id?: string }> | string[],
  configuredModel: string
): boolean {
  const names = (models as Array<{ name?: string; model?: string; id?: string } | string>)
    .flatMap((item) => {
      if (typeof item === "string") return [item];
      const name = item.name ?? item.model ?? item.id;
      return name ? [name] : [];
    });
  // Ollama reports quantization suffixes on some pulls (qwen3:8b-q4_K_M), and a
  // bare name defaults to :latest. MLX servers report a bare directory
  // basename, sometimes with a vendor prefix. Exact equality disabled the whole
  // app for those installs, so compare on the base name and tag prefix.
  const normalize = (value: string): { name: string; tag: string } => {
    const withoutVendor = value.includes("/") ? value.slice(value.lastIndexOf("/") + 1) : value;
    const [name, tag = "latest"] = withoutVendor.trim().split(":");
    return { name, tag };
  };
  const configured = normalize(configuredModel);
  return names.some((installed) => {
    const candidate = normalize(installed);
    if (candidate.name !== configured.name) return false;
    return candidate.tag === configured.tag || candidate.tag.startsWith(`${configured.tag}-`);
  });
}

export interface ChatCompletion {
  content: string;
  /** The response stopped because the output budget was exhausted. */
  truncated: boolean;
}

/**
 * One structured chat turn with a JSON Schema constraint.
 *
 * Both providers enforce the schema during decoding, and both report a
 * budget-exhaustion stop reason — Ollama as `done_reason: "length"`, OpenAI as
 * `choices[0].finish_reason: "length"`. Callers rely on `truncated` to classify
 * a partial response instead of letting JSON.parse throw.
 */
export async function structuredChatCompletion(input: {
  system: string;
  user: string;
  schema: object;
  schemaName: string;
  maxTokens: number;
  timeoutMs: number;
}): Promise<ChatCompletion> {
  const provider = localModelProvider();
  const model = validatedLocalModelName();

  if (provider === "ollama") {
    const response = await localModelFetch("/api/chat", {
      method: "POST",
      body: JSON.stringify({
        model,
        stream: false,
        think: false,
        format: input.schema,
        options: { temperature: 0, num_predict: input.maxTokens },
        messages: [
          { role: "system", content: `${input.system}\n\n/no_think` },
          { role: "user", content: `${input.user}\n\n/no_think` }
        ]
      })
    }, input.timeoutMs);
    if (response.status === 404) throw new Error("LOCAL_MODEL_HTTP_404");
    if (!response.ok) throw new Error(`LOCAL_MODEL_HTTP_${response.status}`);
    const body = (await response.json()) as {
      message?: { content?: string };
      done_reason?: string;
    };
    const content = body.message?.content;
    if (!content) throw new Error("LOCAL_MODEL_EMPTY_RESPONSE");
    return { content, truncated: body.done_reason === "length" };
  }

  const response = await localModelFetch("/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({
      model,
      stream: false,
      temperature: 0,
      max_tokens: input.maxTokens,
      response_format: {
        type: "json_schema",
        json_schema: { name: input.schemaName, schema: input.schema, strict: true }
      },
      messages: [
        { role: "system", content: input.system },
        { role: "user", content: input.user }
      ]
    })
  }, input.timeoutMs);
  if (response.status === 401 || response.status === 403) {
    throw new Error("LOCAL_MODEL_AUTH_REJECTED");
  }
  if (response.status === 404) throw new Error("LOCAL_MODEL_HTTP_404");
  if (!response.ok) throw new Error(`LOCAL_MODEL_HTTP_${response.status}`);
  const body = (await response.json()) as {
    choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
  };
  const choice = body.choices?.[0];
  const content = choice?.message?.content;
  if (!content) throw new Error("LOCAL_MODEL_EMPTY_RESPONSE");
  return { content, truncated: choice?.finish_reason === "length" };
}

export async function visualTranscription(
  imageBase64: string,
  prompt: string,
  maxTokens: number
): Promise<string> {
  const provider = localModelProvider();
  const model = validatedLocalVisualModelName();

  if (provider === "ollama") {
    const response = await localModelFetch("/api/generate", {
      method: "POST",
      body: JSON.stringify({
        model,
        stream: false,
        think: false,
        prompt: `${prompt} /no_think`,
        images: [imageBase64],
        options: { temperature: 0, num_predict: maxTokens }
      })
    }, modelTimeoutForTokens(maxTokens));
    if (!response.ok) throw new Error(`LOCAL_VISUAL_MODEL_HTTP_${response.status}`);
    const body = (await response.json()) as { response?: string };
    if (!body.response?.trim()) throw new Error("LOCAL_VISUAL_MODEL_EMPTY_RESPONSE");
    return body.response.trim();
  }

  const response = await localModelFetch("/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({
      model,
      stream: false,
      temperature: 0,
      max_tokens: maxTokens,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: `data:image/png;base64,${imageBase64}` } }
          ]
        }
      ]
    })
  }, modelTimeoutForTokens(maxTokens));
  if (response.status === 401 || response.status === 403) {
    throw new Error("LOCAL_MODEL_AUTH_REJECTED");
  }
  if (!response.ok) throw new Error(`LOCAL_VISUAL_MODEL_HTTP_${response.status}`);
  const body = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = body.choices?.[0]?.message?.content;
  if (!content?.trim()) throw new Error("LOCAL_VISUAL_MODEL_EMPTY_RESPONSE");
  return content.trim();
}
