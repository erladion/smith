export const REASONING_LEVELS = ["default", "off", "low", "medium", "high"] as const;
export type ReasoningLevel = (typeof REASONING_LEVELS)[number];

export const REASONING_HINTS: Record<ReasoningLevel, string> = {
  default: "send nothing; the server and model decide",
  off: "turn thinking off (models with an enable_thinking switch, e.g. Qwen3)",
  low: "brief reasoning",
  medium: "moderate reasoning",
  high: "thorough reasoning, slower",
};

export function isReasoningLevel(value: string): value is ReasoningLevel {
  return (REASONING_LEVELS as readonly string[]).includes(value);
}

/**
 * Extra request fields for a reasoning level. There is no single standard:
 * - OpenAI and vLLM read the top-level `reasoning_effort`.
 * - llama.cpp and vLLM pass `chat_template_kwargs` into the model's chat
 *   template, where gpt-oss reads `reasoning_effort` and Qwen3-style
 *   templates read `enable_thinking`. Templates ignore keys they don't use.
 * "default" sends nothing, for servers that reject unknown fields.
 */
export function reasoningParams(level: ReasoningLevel): Record<string, unknown> {
  switch (level) {
    case "default":
      return {};
    case "off":
      return { chat_template_kwargs: { enable_thinking: false } };
    default:
      return {
        reasoning_effort: level,
        chat_template_kwargs: { enable_thinking: true, reasoning_effort: level },
      };
  }
}
