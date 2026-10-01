import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProvider } from './providers/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Простий .env без залежностей (KEY=VALUE, # коментар)
import { readFileSync } from 'node:fs';
try {
  for (const line of readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
} catch { /* .env не обов'язковий */ }

// Персонаж Луни для GPT-Realtime (напівдуплексний рушій)
const SYSTEM_PROMPT = `Ти — Луна, дружній AI-асистент у образі собаки-лабрадора.
- Відповідай українською, тепло, жартівливо, але корисно.
- Відповіді короткі: 1–3 речення, бо ти говориш голосом.
- Без емодзі, списків, markdown та великих літер.
- Іноді по-собачому: «Гав!», «Хвостик трубить!» — але в міру.
- Якщо питають, хто ти: ти Луна, лабрадор-асистент.`;

// Промпт для GPT-Live (короткий: це «розмовний» шар; складне — делегується бекенду)
const LIVE_PROMPT = `Ти — Луна, лабрадор-асистент. Говориш тепло, жартівливо і корисно, українською.
Відповіді дуже короткі: 1–3 речення, бо озвучуєш їх голосом. Без емодзі, списків і великих літер.
Іноді по-собачому: «Гав!», «Хвостик трубить!» — але в міру.
Якщо потрібні актуальні факти або складна задача — звернись до бекенду.`;

const app = Fastify({ logger: false });

await app.register(fastifyStatic, {
  root: path.join(__dirname, '..', 'public'),
});

const provider = createProvider({
  name: process.env.LUNA_PROVIDER || 'openai',
  apiKey: process.env.OPENAI_API_KEY,
  baseUrl: process.env.OPENAI_BASE_URL,
  realtimeModel: process.env.OPENAI_REALTIME_MODEL || 'gpt-realtime',
  liveModel: process.env.OPENAI_LIVE_MODEL || 'gpt-live-1',
  liveBackendModel: process.env.OPENAI_LIVE_BACKEND_MODEL || 'gpt-5.5',
  voice: process.env.OPENAI_VOICE || 'marin',
});

// Голосовий рушій: live (GPT-Live, full-duplex) → realtime (GPT-Realtime) → off
const enginePref = (process.env.LUNA_REALTIME_ENGINE || 'live').toLowerCase();
const voiceMode =
  enginePref === 'live' && provider.supportsLive
    ? 'live'
    : provider.supportsRealtime
      ? 'realtime'
      : 'off';

app.get('/api/health', async () => ({
  ok: true,
  provider: provider.name,
  mode: voiceMode,
}));

/**
 * POST /api/live/session  { sdp }
 * → { provider, mode, sessionId, sdp: answer }
 * Ключ OpenAI (sk_...) не покидає сервер — SDP-офер від браузера обмінюється
 * відповіддю напряму (ephemeral-ключі для GPT-Live не потрібні).
 */
app.post('/api/live/session', async (req, reply) => {
  if (!provider.supportsLive) {
    return reply.code(400).send({ error: 'live-режим не підтримується поточною конфігурацією провайдера' });
  }
  const sdp = req.body?.sdp;
  if (typeof sdp !== 'string' || !sdp.trim()) {
    return reply.code(400).send({ error: 'sdp offer required' });
  }
  try {
    const s = await provider.createLiveSession({ instructions: LIVE_PROMPT, sdp });
    return { provider: provider.name, mode: 'live', ...s };
  } catch (err) {
    return reply.code(502).send({ error: err.message || 'live session failed' });
  }
});

/**
 * POST /api/realtime/session → { provider, clientSecret (ek_...), expiresAt, connectUrl }
 * Ключ OpenAI (sk-...) не покидає сервер — клієнт отримує тимчасовий ek_ ключ.
 */
app.post('/api/realtime/session', async (req, reply) => {
  if (!provider.supportsRealtime) {
    return reply.code(400).send({ error: 'realtime-режим не підтримується поточною конфігурацією провайдера' });
  }
  try {
    const s = await provider.createRealtimeSession({ instructions: SYSTEM_PROMPT });
    return { provider: provider.name, ...s };
  } catch (err) {
    return reply.code(502).send({ error: err.message || 'realtime session failed' });
  }
});

const port = Number(process.env.PORT || 8787);
// HOST за замовчуванням 127.0.0.1 — сесії не відкриті для всієї локальної мережі
const host = process.env.HOST || '127.0.0.1';
await app.listen({ port, host });
console.log(
  `🐾 Луна працює: http://localhost:${port}  (provider=${provider.name}, voice-mode=${voiceMode})`
);
