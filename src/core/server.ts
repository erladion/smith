import type OpenAI from "openai";

export interface ModelInfo {
  id: string;
  /** Context window, when the listing includes it (vLLM's max_model_len). */
  contextSize?: number;
}

/** What we can learn about an OpenAI-compatible server beyond the chat endpoint. */
export class Server {
  private models: Promise<ModelInfo[]> | null = null;

  constructor(
    private readonly client: OpenAI,
    readonly baseURL: string,
    private readonly apiKey: string,
  ) {}

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
   * The context window for a model, or undefined if the server doesn't say.
   * Tries the model listing (vLLM), then llama.cpp's /props, which reports
   * the per-slot n_ctx (and takes ?model= in router mode).
   */
  async contextSize(model: string): Promise<number | undefined> {
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
