import { OpenAIProvider } from './openai.js';

/**
 * Фабрика провайдерів. Додавання нової платформи:
 *   1. server/providers/<name>.js — підклас BaseProvider
 *   2. case у switch нижче
 *   3. LUNA_PROVIDER=<name> у .env
 */
export function createProvider(opts) {
  switch (opts.name) {
    case 'openai':
      return new OpenAIProvider({
        apiKey: opts.apiKey,
        baseUrl: opts.baseUrl,
        realtimeModel: opts.realtimeModel,
        liveModel: opts.liveModel,
        liveBackendModel: opts.liveBackendModel,
        voice: opts.voice,
      });
    // case 'anthropic': return new AnthropicProvider(opts);
    // case 'gemini':    return new GeminiProvider(opts);
    default:
      throw new Error(`Unknown LUNA_PROVIDER: ${opts.name}`);
  }
}
