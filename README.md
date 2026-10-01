# 🐾 Луна — AI-лабрадор асистент

Голосовий чат з AI-собакою у реальному часі. Луна — лабрадор, який слухає,
думає, посміхається і відповідає голосом. На екрані — анімована SVG-собака
зі станами: **чекає → слухає → думає → говорить**.

Є **два голосові рушії** (обирається за `.env` + підтримкою провайдера):

1. **Live (GPT-Live, `gpt-live-1`)** — основний. Full-duplex: Луна
   **слухає, поки говорить**, нативна обробка переривань і turn-taking.
   WebRTC, STT/TTS/LLM на сервері OpenAI; складні запити делегуються
   backend-моделі (Responses delegation). $0.05/хв.
2. **Realtime (GPT-Realtime, `gpt-realtime`)** — напівдуплексний WebRTC-рушій
   (VAD, barge-in). Вмикається `LUNA_REALTIME_ENGINE=realtime`.

Якщо провайдер не має голосового API (напр. `OPENAI_BASE_URL` → Ollama) —
`mode: off`, Луна показує підказку, мікрофон вимкнено.

## Запуск

```bash
npm install
npm start          # http://localhost:8787
```

Браузер: Chrome / Edge. Натисни 🎤 (або пробіл) — і говори українською.
У realtime-режимі мікрофон активний постійно (як у дзвінку), є кнопка
mute 🔇. Текст у полі вводу працює в обох режимах.

## Архітектура (пріоритет — низька латентність)

```
┌────────────────────────── Браузер ──────────────────────────┐
│                                                             │
│  🎤 getUserMedia (AEC/NS/AGC)     🐶 SVG-лабрадор          │
│        │                                  стани: idle /     │
│        ▼                                  listening /       │
│  RTCPeerConnection ──► WebRTC (аудіо + data channel)        │
│   track: мікрофон          ▲        thinking / speaking     │
│   track: голос Луни ──► <audio> ─► AnalyserNode → RMS ──►   │
│                          │        рот відкривається         │
│        ◄─────────────────┘        за гучністю голосу        │
│                                                             │
│  Data channel 'oai-events' → стани собаки + чат-бульбашки:  │
│   live:     session.started, input/output_transcript.delta, │
│             session.close(d)                                 │
│   realtime: speech_started/stopped, transcriptions,         │
│             output_audio_buffer.started/stopped/cleared      │
└─────────────────────────────────────────────────────────────┘
        ▲ WebRTC (SDP через REST)          │ POST /api/live/session (live)
        │                                  │ POST /api/realtime/session (realtime)
        ▼                                  ▼
┌──────────────────────── Сервер (Fastify) ───────────────────┐
│  live:     POST /v1/live/sessions (sk_ ключ, SDP-офер →     │
│            відповідь; ephemeral-ключі не потрібні)           │
│  realtime: POST /v1/realtime/client_secrets → ek_ для       │
│            браузера (sk_ не покидає сервер)                  │
│  providers/ (фабрика): openai.js (Live + Realtime),         │
│   інші платформи — одним підкласом BaseProvider              │
└─────────────────────────────────────────────────────────────┘
```

### Як працює live-режим (GPT-Live, основний)

1. Браузер: `getUserMedia({ echoCancellation, noiseSuppression, autoGainControl })`
   → `RTCPeerConnection` (мікрофон-трек + data channel `oai-events`) →
   `createOffer()` → чекання ICE-gathering → `POST /api/live/session` (SDP).
2. Сервер: `POST https://api.openai.com/v1/live/sessions` з сесією
   `{ model: gpt-live-1, instructions (персонаж Луни), audio.output.voice,
   delegation: { type: responses, responses: { model: gpt-5.5 } } }` та
   `transport: { type: webrtc, sdp }` → повертає SDP-відповідь.
3. `gpt-live-1` — **full-duplex**: веде розмову сама, слухає, поки говорить,
   нативно визначає черги реплік; актуальні факти/складні задачі делегує
   backend-моделі (Responses API). Стани собаки визначаються клієнтом з
   `session.input/output_transcript.delta` (хто "на хвилі") + RMS
   мікрофона (чи говорить людина).
4. Mute — `session.input_audio.mute` + `track.enabled = false`.
5. Завершення — `session.close` → `session.closed` (з usage) → cleanup.

### Realtime-режим (GPT-Realtime, fallback-рушій)

1. `POST /api/realtime/session` → сервер створює тимчасовий `client_secret`
   (`ek_…`) через `/realtime/client_secrets` (персонаж Луни). `sk_` лишається
   на сервері.
2. Браузер: SDP-офер → напряму `POST /v1/realtime/calls` з `ek_` → відповідь.
3. Події каналу керують станами:
   - `speech_started` → **слухаю** (barge-in: Луна замовкає, бульбашка
     зберігає лише те, що встигла сказати);
   - `speech_stopped` → **думаю** + одразу порожня бульбашка користувача
     (транскрипт приходить пізніше — порядок реплік у чаті зберігається);
   - `output_audio_buffer.started/stopped/cleared` → **говорю/слухаю**,
     рот від RMS гучності (AnalyserNode на віддаленому потоці).

### Якщо голос не підтримується (`mode: off`)

`GET /api/health` → `mode: live|realtime|off` (`LUNA_REALTIME_ENGINE=live|realtime`
+ підтримка провайдера; для не-OpenAI `OPENAI_BASE_URL` — завжди `off`).
Клієнт показує підказку й вимикає мікрофон — додати голос для нової
платформи = реалізувати `createLiveSession()` / `createRealtimeSession()`
у її провайдері.

### Чому швидко

1. **Full-duplex без пауз між репліками** — GPT-Live не чекає мовчання,
   аудіо йде браузер ↔ OpenAI напряму по WebRTC.
2. **Barge-in на рівні моделі** — переривання обробляється нативно,
   без ривання з'єднання.
3. **Короткі відповіді** — промпт обмежує 1–3 речення.
4. **Fastify + нативний fetch** — без важких залежностей.

## Конфігурація (`.env`)

| Змінна | Опис |
|---|---|
| `LUNA_PROVIDER` | `openai` (інші — додати у `server/providers/`) |
| `OPENAI_API_KEY` | ключ OpenAI (лишається на сервері) |
| `OPENAI_BASE_URL` | OpenAI-сумісні API: Ollama, OpenRouter, Groq… (тоді `mode: off`) |
| `LUNA_REALTIME_ENGINE` | голосовий рушій: `live` (за замовчуванням) або `realtime` |
| `OPENAI_LIVE_MODEL` | GPT-Live модель, за замовчуванням `gpt-live-1` |
| `OPENAI_LIVE_BACKEND_MODEL` | backend для делегованих задач, за замовчуванням `gpt-5.5` |
| `OPENAI_REALTIME_MODEL` | модель Realtime API, за замовчуванням `gpt-realtime` |
| `OPENAI_VOICE` | голос Луни (обома рушіями), за замовчуванням `marin` |
| `PORT` | за замовчуванням `8787` |
| `HOST` | за замовчуванням `127.0.0.1` |

## Як додати нову платформу (напр., Anthropic)

1. `server/providers/anthropic.js` — підклас `BaseProvider`.
   Реалізувати `createLiveSession({ instructions, sdp })` (WebRTC-сесія
   через POST з SDP) або `createRealtimeSession({ instructions })`
   (тимчасовий ключ для браузера) — якщо платформа має голосовий API.
2. `case 'anthropic'` у `server/providers/index.js`.
3. `LUNA_PROVIDER=anthropic` у `.env`.

Контракт провайдера — два голосові методи, решта системи не змінюється.

## Roadmap

- ~~**WebRTC-режим**~~ ✅ — GPT-Realtime (barge-in, VAD).
- ~~**GPT-Live (gpt-live-1)**~~ ✅ — full-duplex, основний рушій.
- **Redis для сесій**, мультиклієнти, голос-персонаж для Луни.
- Власний VAD (webrtcvad-wasm) для тонких налаштувань пауз у live-режимі.
