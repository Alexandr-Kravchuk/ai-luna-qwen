/**
 * Базовий клас провайдера.
 * Контракт (голосові рушії):
 *  - async createLiveSession({ instructions, sdp }) -> { sessionId, sdp }
 *    (GPT-Live-стиль: WebRTC-сесія через POST з SDP; повний дуплекс);
 *  - async createRealtimeSession({ instructions }) -> { clientSecret, expiresAt, connectUrl }
 *    (Realtime API: тимчасовий ключ, браузер сам робить SDP-handshake).
 * Нова платформа = підклас + реєстрація у index.js.
 */
export class BaseProvider {
  get name() {
    return 'base';
  }

  /** Чи підтримує провайдер realtime-режим (WebRTC). */
  get supportsRealtime() {
    return false;
  }

  /** Чи підтримує провайдер GPT-Live (full-duplex WebRTC, /v1/live/sessions). */
  get supportsLive() {
    return false;
  }

  /**
   * Створити live-сесію: сервер обмінює SDP-офер відповіддю.
   * @param {{ instructions: string, sdp: string }} params
   * @returns {Promise<{ sessionId: string, sdp: string }>}
   */
  async createLiveSession() {
    throw new Error('live not supported');
  }

  /**
   * Створити тимчасову realtime-сесію.
   * @param {{ instructions: string }} params
   * @returns {Promise<{ clientSecret: string, expiresAt: string, connectUrl: string }>}
   */
  async createRealtimeSession() {
    throw new Error('realtime not supported');
  }
}
