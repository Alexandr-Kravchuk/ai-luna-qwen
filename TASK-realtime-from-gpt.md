# Задача: перевести Луну на OpenAI Realtime (WebRTC) за зразком `ai-luna`

## Мета

Зараз у цьому проєкті (`/Users/a-kravchuk/Projects/ai-luna-qwen`) голос обробляє браузер: Web Speech API розпізнає мову, `speechSynthesis` озвучує. Через це є три проблеми:
- від кінця фрази до першого звуку відповіді ~1,5–2 с;
- голос роботизований;
- працює тільки в Chrome/Edge.

Проєкт `/Users/a-kravchuk/Projects/ai-luna` (далі **GPT-версія**) вже працює через OpenAI Realtime API по WebRTC. Затримку там заміряли: ~0,7 с від кінця фрази до першого звуку. Перенеси цей механізм сюди, а все сильне, що є в цьому проєкті, збережи.

## Що прочитати перед початком

1. `/Users/a-kravchuk/Projects/ai-luna/server/index.js` — функція `createSession` в об'єкті `providers.openai`. Звідти береш запит до OpenAI.
2. `/Users/a-kravchuk/Projects/ai-luna/src/ui/App.tsx` — функції `connect`, `handleEvent`, `disconnect`, `toggleMute`. Звідти береш логіку WebRTC. Код там записаний дуже щільними рядками, тож спершу розбери його по кроках.
3. У цьому проєкті: `server/index.js`, `server/providers/*.js`, `public/app.js`, `public/index.html`, `public/style.css`.

## Що перенести з GPT-версії

1. **Серверний ендпоінт тимчасового ключа.** `POST https://api.openai.com/v1/realtime/client_secrets` із тілом:
   ```json
   {
     "session": {
       "type": "realtime",
       "model": "gpt-realtime",
       "output_modalities": ["audio"],
       "instructions": "<SYSTEM_PROMPT>",
       "audio": {
         "output": { "voice": "marin" },
         "input": {
           "transcription": { "model": "gpt-4o-mini-transcribe" },
           "turn_detection": { "type": "semantic_vad" }
         }
       }
     }
   }
   ```
   З відповіді потрібні `value` (тимчасовий ключ, починається з `ek_`) і `expires_at`.
   У нашому сервері це новий маршрут `POST /api/realtime/session` → `{ provider, clientSecret, expiresAt, connectUrl }`. Модель і голос беруться з `OPENAI_REALTIME_MODEL` / `OPENAI_VOICE`, `instructions` — наш `SYSTEM_PROMPT`.
2. **WebRTC-підключення в браузері:**
   - `getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })`;
   - `new RTCPeerConnection()`, додати трек мікрофона;
   - `pc.createDataChannel('oai-events')` — через цей канал ідуть події;
   - `createOffer` → `setLocalDescription` → `POST https://api.openai.com/v1/realtime/calls` із заголовками `Authorization: Bearer <ek_…>` і `Content-Type: application/sdp`; тіло — `offer.sdp`;
   - відповідь (текст SDP) передати в `setRemoteDescription({ type: 'answer', sdp })`;
   - `pc.ontrack` → підставити `event.streams[0]` у `<audio autoplay>` і викликати `play()`. Якщо браузер заблокував автовідтворення, показати кнопку «Увімкнути звук», як у GPT-версії.
3. **Обробку подій із каналу `oai-events`.** Перевірено на живому API, події приходять ось у такому порядку:
   ```
   session.created
   input_audio_buffer.speech_started                      → стан "listening"
   input_audio_buffer.speech_stopped                      → стан "thinking"
   conversation.item.input_audio_transcription.completed  → бульбашка користувача (поле transcript)
   response.created
   output_audio_buffer.started                            → стан "speaking"
   response.output_audio_transcript.delta                 → дописувати текст бульбашки Луни (поле delta)
   response.output_audio_transcript.done                  → фінальний текст (поле transcript)
   response.done
   output_audio_buffer.stopped                            → стан "listening"
   ```
4. **Кнопки мікрофона й завершення розмови.** Mute робиться через `track.enabled = false`. `disconnect()` закриває `pc` і зупиняє всі треки.

## Чого з GPT-версії НЕ переносити (там це помилки)

- **Поле для API-ключа в браузері, `localStorage` і заголовок `x-openai-api-key`.** Ключ живе тільки в `.env` на сервері. Сервер не приймає ключ від клієнта.
- **Перемикання в «слухає» на `response.done`.** Ця подія означає, що генерація закінчилась, але звук ще грає. Стан «слухає» вмикай на `output_audio_buffer.stopped`, «говорить» — на `output_audio_buffer.started`.
- **Стиль коду, коли кілька операторів записано в один рядок.** Пиши так, як уже написано в цьому проєкті: окремі функції, короткі коментарі українською.
- **Фото замість SVG.** SVG-собаку з цього проєкту залишаємо, вона краще показує, що Луна говорить.

## Що зберегти з цього проєкту

- **Шар провайдерів** (`server/providers/`). Додай у `BaseProvider` метод `async createRealtimeSession({ instructions })` → `{ clientSecret, expiresAt, connectUrl }`. За замовчуванням він кидає помилку `realtime not supported`. У `OpenAIProvider` реалізуй його запитом із пункту 1 вище. `connectUrl` = `https://api.openai.com/v1/realtime/calls`. Так клієнт бере адресу з відповіді сервера, а не тримає URL OpenAI у своєму коді.
- **Поточний режим `/api/chat` (SSE + Web Speech)** — як запасний. Логіка вибору:
  - `GET /api/health` повертає ще й `realtime: true|false`;
  - `true` → клієнт працює через WebRTC;
  - `false` (інший провайдер, або `OPENAI_BASE_URL` вказує на Ollama/Groq) → старий шлях, без змін.
- **Текстове поле вводу.** У режимі Realtime текст відправляється через канал подій:
  ```js
  dc.send(JSON.stringify({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } }));
  dc.send(JSON.stringify({ type: 'response.create' }));
  ```
- **SVG-собаку, стани `idle / listening / thinking / speaking`, `SYSTEM_PROMPT`, пробіл як гарячу клавішу.**

## Що покращити в собаці

Зараз рот відкривається CSS-анімацією `talk` (`public/style.css`, ~рядок 194) з постійним ритмом. У режимі Realtime зроби, щоб рот відкривався за гучністю голосу Луни:
- `AudioContext` → `createMediaStreamSource(remoteStream)` → `AnalyserNode`;
- у `requestAnimationFrame` рахуй RMS амплітуди і став `#mouthOpen` у `transform: scaleY(0.4 + rms * k)`;
- поки йде ця анімація, вимикай CSS-анімацію `talk`, щоб вони не конфліктували;
- важливо: аналізатор НЕ підключай до `destination`, інакше звук гратиме двічі. Відтворює `<audio>`, аналізатор тільки слухає.

## Нові змінні `.env`

```
OPENAI_REALTIME_MODEL=gpt-realtime
OPENAI_VOICE=marin
HOST=127.0.0.1
```
Допиши їх також в `.env.example`. `app.listen` використовує `HOST` (за замовчуванням `127.0.0.1`, а не `0.0.0.0`). Інакше будь-хто в локальній мережі зможе відкривати сесії за наш рахунок.

## Обмеження

- Нових npm-залежностей не додавати. Сервер на Fastify, клієнт — чистий JS без збірки, так і лишається.
- Не чіпати `/Users/a-kravchuk/Projects/ai-luna` — він тільки для читання.
- Не виводити API-ключ у лог, у відповідь сервера і в консоль браузера.

## Як перевірити, що готово

1. `npm start` — сервер стартує без помилок.
2. `curl -s localhost:8787/api/health` → у відповіді є `"realtime":true`.
3. `curl -s -X POST localhost:8787/api/realtime/session` → у відповіді `clientSecret` починається з `ek_`, рядка `sk-` там немає.
4. Відкрити `http://localhost:8787` у Chrome, натиснути мікрофон, сказати «Привіт, Луно, як тебе звати?»:
   - з'являється бульбашка з розпізнаним текстом;
   - Луна відповідає голосом `marin` (не Lesya) менш ніж за 1 с після того, як ти замовк;
   - поки звук грає, стан «Говорю», рот рухається в такт голосу; коли звук затих — «Слухаю…».
5. Перебити Луну голосом посеред відповіді → вона замовкає і слухає.
6. Написати текст у поле вводу → Луна відповідає голосом.
7. У `.env` поставити `LUNA_PROVIDER=openai` і `OPENAI_BASE_URL=http://localhost:11434/v1` (або будь-яку не-OpenAI адресу) → `/api/health` повертає `realtime:false`, працює старий режим.
8. Оновити `README.md`: нова схема архітектури і пояснення двох режимів. Прибрати неправдиве твердження «аудіо не летить на сервер» — Web Speech API у Chrome відправляє звук на сервери Google.

Коли все зроблено, коротко звітуй, які файли змінено, і результат кожного пункту перевірки: виконано / не виконано й чому.
