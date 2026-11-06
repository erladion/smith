import OpenAI from "openai";
import type { Endpoint } from "./config.js";
import { describeError } from "./errors.js";

export interface ModelInfo {
  id: string;
  /** Context window, when the listing includes it (vLLM's max_model_len). */
  contextSize?: number;
}

export interface ServerOptions {
  /** Endpoint name from the config file; undefined for an ad-hoc --base-url. */
  name?: string;
  /** Model to use when no other choice applies. */
  model?: string;
  /** Context window to use instead of asking the server. */
  contextSize?: number;
}

/** One OpenAI-compatible server: the API client plus what we can learn about it. */
export class Server {
  readonly client: OpenAI;
  private models: Promise<ModelInfo[]> | null = null;

  constructor(
    readonly baseURL: string,
    private readonly apiKey: string,
    private readonly options: ServerOptions = {},
  ) {
    this.client = new OpenAI({ baseURL, apiKey, maxRetries: 1 });
  }

  /**
   * A configured endpoint. Endpoints without a key get none: global keys from
   * the environment are never sent to a named server they weren't meant for.
   */
  static fromEndpoint(endpoint: Endpoint, apiKeyOverride?: string): Server {
    return new Server(endpoint.baseURL, apiKeyOverride ?? endpoint.apiKey ?? "no-key", {
      name: endpoint.name,
      model: endpoint.model,
      contextSize: endpoint.contextSize,
    });
  }

  get name(): string | undefined {
    return this.options.name;
  }

  /** "name (url)" for configured endpoints, the URL otherwise. */
  get label(): string {
    return this.options.name ? `${this.options.name} (${this.baseURL})` : this.baseURL;
  }

  /** Models the server advertises. Cached; pass refresh to ask again. */
  listModels(refresh = false): Promise<ModelInfo[]> {
    if (refresh || !this.models) {
      const request = (async () => {
        const out: ModelInfo[] = [];
        for await (const model of this.client.models.list()) {
          const extra = model as unknown as { max_model_len?: unknown };
          out.push({
            id: model.id,
            contextSize: typeof extra.max_model_len === "number" ? extra.max_model_len : undefined,
          });
        }
        return out;
      })();
      // Don't cache failures; the server may come up later.
      request.catch(() => {
        if (this.models === request) this.models = null;
      });
      this.models = request;
    }
    return this.models;
  }

  /**
   * Picks a model: the first of `preferred` the server lists, then the
   * endpoint's configured model, then the first model listed.
   */
  async chooseModel(preferred: (string | undefined)[]): Promise<string> {
    let models: ModelInfo[];
    try {
      models = await this.listModels();
    } catch (err) {
      // The server may not implement /v1/models; a configured model still works.
      if (this.options.model) return this.options.model;
      // A connection error explains itself; otherwise say what we were doing and the way around it.
      if (err instanceof OpenAI.APIConnectionError) throw new Error(describeError(err, this.baseURL));
      throw new Error(`Could not list models at ${this.baseURL}: ${describeError(err, this.baseURL)}\nPass --model, or set "model" for the endpoint in the config file.`);
    }
    const ids = new Set(models.map((m) => m.id));
    const match = [...preferred, this.options.model].find((id): id is string => id !== undefined && ids.has(id));
    const chosen = match ?? models[0]?.id ?? this.options.model;
    if (!chosen) throw new Error(`${this.baseURL} lists no models. Pass --model.`);
    return chosen;
  }

  /**
   * The context window for a model, or undefined if unknown. A configured
   * size wins; then the model listing (vLLM), then llama.cpp's /props, which
   * reports the per-slot n_ctx (and takes ?model= in router mode).
   */
  async contextSize(model: string): Promise<number | undefined> {
    if (this.options.contextSize) return this.options.contextSize;

    const listed = await this.listModels().catch(() => []);
    const fromList = listed.find((m) => m.id === model)?.contextSize;
    if (fromList) return fromList;

    const root = this.baseURL.replace(/\/v1\/?$/, "");
    try {
      const res = await fetch(`${root}/props?model=${encodeURIComponent(model)}`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
        signal: AbortSignal.timeout(3_000),
      });
      if (!res.ok) return undefined;
      const props = (await res.json()) as { n_ctx?: unknown; default_generation_settings?: { n_ctx?: unknown } };
      const n = props.default_generation_settings?.n_ctx ?? props.n_ctx;
      return typeof n === "number" && n > 0 ? n : undefined;
    } catch {
      return undefined;
    }
  }
}
