import OpenAI from "openai";

/** Turns API and network errors into one readable line for the transcript. */
export function describeError(err: unknown, baseURL: string): string {
  if (err instanceof OpenAI.APIConnectionError) {
    return `Could not reach ${baseURL}. Is the server running? (${err.message})`;
  }
  if (err instanceof OpenAI.APIError) {
    const status = err.status ? `HTTP ${err.status}: ` : "";
    return `Server error. ${status}${err.message}`;
  }
  return err instanceof Error ? err.message : String(err);
}
