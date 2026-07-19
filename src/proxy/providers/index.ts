/**
 * LLM Content Provider Registry
 * Auto-detects the appropriate provider based on request URL/headers.
 */

import type { LLMContentProvider } from "./types.js";
import { OpenAIProvider } from "./openai.js";
import { AnthropicProvider } from "./anthropic.js";
import { ResponsesProvider } from "./responses.js";

export type {
  LLMContentProvider,
  ToolCallInfo,
  ToolResultMessage,
} from "./types.js";
export { OpenAIProvider } from "./openai.js";
export { AnthropicProvider } from "./anthropic.js";
export { ResponsesProvider } from "./responses.js";

/** Built-in providers */
// ResponsesProvider must precede OpenAIProvider: the OpenAI matcher accepts
// any "Bearer sk-" request, which would shadow /v1/responses routing.
const PROVIDERS: LLMContentProvider[] = [
  new ResponsesProvider(),
  new OpenAIProvider(),
  new AnthropicProvider(),
];

/**
 * Detect the appropriate LLM content provider for a request.
 *
 * @param url - The request URL
 * @param headers - The request headers
 * @param hint - Optional provider name hint (skips auto-detection)
 * @returns The matching provider
 * @throws Error if no provider matches and no hint given
 */
export function detectProvider(
  url: string,
  headers: Headers,
  hint?: "openai" | "anthropic" | "responses" | "auto",
): LLMContentProvider {
  // If a specific provider is requested, return it directly
  if (hint && hint !== "auto") {
    const provider = PROVIDERS.find((p) => p.name === hint);
    if (provider) return provider;
    throw new Error(`Unknown LLM provider: ${hint}`);
  }

  // Auto-detect from URL and headers
  for (const provider of PROVIDERS) {
    if (provider.matchesRequest(url, headers)) {
      return provider;
    }
  }

  // Default to OpenAI format (most common / compatible)
  console.warn(
    `[rehydra] No LLM provider matched for ${url} — defaulting to OpenAI format`,
  );
  return PROVIDERS[0]!;
}
