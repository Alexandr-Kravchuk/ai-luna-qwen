import { BaseProvider } from './base.js';

const OPENAI_BASE = 'https://api.openai.com/v1';

/**
 * OpenAI: GPT-Live (gpt-live-1) та GPT-Realtime (gpt-realtime) по WebRTC.
 * Голосові рушії працюють тільки з основного API (api.openai.com);
 * інші baseUrl (Ollama, OpenRouter, Groq...) — сумісні з chat, але без голосу.
 */
export class OpenAIProvider extends BaseProvider {
  #apiKey;
  #baseUrl;
  #realtimeModel;
  #liveModel;
  #liveBackendModel;
  #voice;

  constructor({
    apiKey,
    baseUrl = OPENAI_BASE,
    realtimeModel = 'gpt-realtime',
    liveModel = 'gpt-live-1',
    liveBackendModel = 'gpt-5.5',
    voice = 'marin',
  }) {
    super();
    if (!apiKey) throw new Error('OpenAIProvider: apiKey is required');
    this.#apiKey = apiKey;
    this.#baseUrl = baseUrl.replace(/\/+$/, '');
    this.#realtimeModel = realtimeModel;
    this.#liveModel = liveModel;
    this.#liveBackendModel = liveBackendModel;
    this.#voice = voice;
  }

  get name() {
    return 'openai';
  }

  /** WebRTC-режими працюють лише з api.openai.com (інші baseUrl — OpenAI-сумісні, але без realtime). */
  get supportsRealtime() {
    return this.#baseUrl === OPENAI_BASE;
  }

  /** GPT-Live (full-duplex) — теж тільки основний API OpenAI. */
  get supportsLive() {
    return this.#baseUrl === OPENAI_BASE;
  }

  /**
   * GPT-Live сесія (POST /v1/live/sessions): SDP-офер від браузера
   * обмінюється відповіддю напряму на сервері. Ключ sk_ не покидає сервер
   * (ephemeral-ключі не потрібні). Full-duplex: модель слухає, поки говорить.
   */
  async createLiveSession({ instructions, sdp }) {
    const res = await fetch(`${OPENAI_BASE}/live/sessions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.#apiKey}`,
      },
      body: JSON.stringify({
        session: {
          model: this.#liveModel,
          instructions,
          audio: { output: { voice: this.#voice } },
          // Бекенд для делегованих задач (актуальні факти, складні запити).
          // Просту розмову gpt-live-1 веде сам.
          delegation: {
            type: 'responses',
            responses: {
              model: this.#liveBackendModel,
              instructions:
                'Відповідай українською, дуже коротко (1–2 речення), без емодзі, списків і markdown — відповідь озвучить голосом Луна.',
            },
          },
        },
        transport: { type: 'webrtc', sdp },
      }),
    });

    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(payload?.error?.message || `OpenAI ${res.status}`);
    }
    if (!payload?.transport?.sdp) {
      throw new Error('OpenAI live: у відповіді немає SDP');
    }

    return { sessionId: payload.session?.id ?? null, sdp: payload.transport.sdp };
  }

  /**
   * Тимчасовий ключ (ek_...) для WebRTC-зв'язку з Realtime API.
   * Сам ключ OpenAI (sk-...) нікуди не передається — тільки на сервері.
   */
  async createRealtimeSession({ instructions }) {
    const res = await fetch(`${OPENAI_BASE}/realtime/client_secrets`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.#apiKey}`,
      },
      body: JSON.stringify({
        session: {
          type: 'realtime',
          model: this.#realtimeModel,
          output_modalities: ['audio'],
          instructions,
          audio: {
            output: { voice: this.#voice },
            input: {
              transcription: { model: 'gpt-4o-mini-transcribe' },
              turn_detection: { type: 'semantic_vad' },
            },
          },
        },
      }),
    });

    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(payload?.error?.message || `OpenAI ${res.status}`);
    }

    return {
      clientSecret: payload.value,
      expiresAt: payload.expires_at,
      connectUrl: `${OPENAI_BASE}/realtime/calls`,
    };
  }
}
