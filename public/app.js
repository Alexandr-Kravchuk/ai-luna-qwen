/* Луна — клієнт з двома голосовими рушіями (визначає GET /api/health → mode):
 * 1) live:     GPT-Live (gpt-live-1), WebRTC, full-duplex — модель слухає,
 *              поки говорить; SDP-офер іде через наш сервер;
 * 2) realtime: GPT-Realtime, WebRTC, напівдуплекс (VAD, barge-in).
 * Якщо mode: 'off' — голосовий рушій не підтримується конфігурацією. */

// ─── Елементи ─────────────────────────────────────────────
const dogEl = document.getElementById('dog');
const statusEl = document.getElementById('status');
const statusText = document.getElementById('statusText');
const chatEl = document.getElementById('chat');
const micBtn = document.getElementById('mic');
const muteBtn = document.getElementById('muteBtn');
const soundBtn = document.getElementById('soundBtn');
const remoteAudio = document.getElementById('remoteAudio');
const form = document.getElementById('composer');
const textInput = document.getElementById('textInput');
const metaEl = document.getElementById('meta');
const mouthEl = document.getElementById('mouthOpen');

// ─── Стан ─────────────────────────────────────────────────
let mode = 'idle'; // idle | listening | thinking | speaking (стан собаки)

// Голосовий рушій: 'live' | 'realtime' | 'off'
let voiceEngine = 'off';
let connected = false; // WebRTC-зв'язок активний
let micMuted = false;
let pc = null; // RTCPeerConnection
let dc = null; // data channel 'oai-events'
let micStream = null; // MediaStream мікрофона

// realtime (GPT-Realtime)
let lunaRtBubble = null; // бульбашка Луни, що набирається delta
let pendingUserBubble = null; // порожня бульбашка користувача на speech_stopped

// live (GPT-Live)
let liveReady = false; // отримано session.started
let livePending = false; // чекаємо session.started
let lunaBubble = null; // live: бульбашка Луни
let userBubble = null; // live: бульбашка користувача
let lunaWasActive = false; // live: Луна "на хвилі" (фрагменти приходять)
let userWasActive = false; // live: користувач говорить (фрагменти приходять)
let lastInputAt = 0;
let lastOutputAt = 0;
let lastMicActiveAt = 0;
let stateTimer = 0; // live: цикл станів (mic RMS + decay)
let hintTimer = 0;

const LABELS = {
  idle: 'Чекаю на тебе',
  listening: 'Слухаю…',
  thinking: 'Думаю…',
  speaking: 'Говорю',
};

const ALL_STATES = ['state-idle', 'state-listening', 'state-thinking', 'state-speaking'];

function setMode(m) {
  if (mode === m) return;
  mode = m;
  dogEl.classList.remove(...ALL_STATES);
  dogEl.classList.add(`state-${m}`);
  statusText.textContent = LABELS[m];
  statusEl.dataset.mode = m;
  micBtn.classList.toggle('active', m === 'listening');
}

function setStatus(text) {
  statusText.textContent = text;
}

// ─── Чат-стрічка ──────────────────────────────────────────
function addBubble(cls, text) {
  const div = document.createElement('div');
  div.className = `msg ${cls}`;
  div.textContent = text;
  chatEl.appendChild(div);
  chatEl.scrollTop = chatEl.scrollHeight;
  while (chatEl.children.length > 60) chatEl.firstChild.remove();
  return div;
}
const scrollDown = () => (chatEl.scrollTop = chatEl.scrollHeight);

// GPT-Live транскрипти містять паралінгвістичні теги: [pant], [laughs]... —
// збираємо їх з відображення (тег може розрізатись по шматках, тому
// застосовуємо regex до накопиченого тексту)
function cleanTranscript(text) {
  return text.replace(/\[[a-z_]{1,20}\]/gi, '');
}

// ─── WebRTC: спільне ──────────────────────────────────────

/** Чекати ICE-gathering (як у офіційному quickstart GPT-Live). */
async function waitIceGathering(connection, timeoutMs = 10000) {
  if (connection.iceGatheringState === 'complete') return;
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      connection.removeEventListener('icegatheringstatechange', onState);
      reject(new Error('ICE: таймаут збору кандидатів'));
    }, timeoutMs);
    function onState() {
      if (connection.iceGatheringState !== 'complete') return;
      clearTimeout(t);
      connection.removeEventListener('icegatheringstatechange', onState);
      resolve();
    }
    connection.addEventListener('icegatheringstatechange', onState);
    onState();
  });
}

function onRemoteTrack(event) {
  remoteAudio.srcObject = event.streams[0] ?? new MediaStream([event.track]);
  setupMouthAnalyser(remoteAudio.srcObject);
  // Якщо браузер заблокував автовідтворення — показуємо кнопку
  remoteAudio
    .play()
    .then(() => soundBtn.classList.add('hidden'))
    .catch(() => soundBtn.classList.remove('hidden'));
}

function connectCommon() {
  micMuted = false;
  pc = new RTCPeerConnection();
  pc.ontrack = onRemoteTrack;
  pc.onconnectionstatechange = () => {
    if (pc && (pc.connectionState === 'failed' || pc.connectionState === 'disconnected')) {
      addBubble('error', 'З’єднання перервано. Спробуй ще раз.');
      disconnectVoice();
    }
  };
  micStream.getTracks().forEach((t) => pc.addTrack(t, micStream));
  dc = pc.createDataChannel('oai-events');
}

function disconnectVoice() {
  // live: спочатку graceful close (документований флоу)
  if (voiceEngine === 'live' && connected && liveReady && dc?.readyState === 'open') {
    try { dc.send(JSON.stringify({ type: 'session.close' })); } catch { /* ok */ }
  }
  stopStateLoop();
  stopVoiceMouth();
  if (dc) {
    dc.onmessage = null;
    try { dc.close(); } catch { /* ok */ }
    dc = null;
  }
  if (pc) {
    pc.onconnectionstatechange = null;
    pc.ontrack = null;
    pc.close();
    pc = null;
  }
  if (micStream) {
    micStream.getTracks().forEach((t) => t.stop());
    micStream = null;
  }
  remoteAudio.srcObject = null;
  connected = false;
  liveReady = false;
  livePending = false;
  lunaRtBubble = null;
  pendingUserBubble = null;
  lunaBubble = null;
  userBubble = null;
  lunaWasActive = userWasActive = false;
  lastInputAt = lastOutputAt = lastMicActiveAt = 0;
  micMuted = false;
  document.body.classList.remove('rt-live');
  micBtn.classList.remove('live');
  muteBtn.classList.add('hidden');
  muteBtn.classList.remove('muted');
  soundBtn.classList.add('hidden');
  setMode('idle');
}

/** Голосовий зв'язок готовий (realtime: після SDP, live: після session.started). */
function onVoiceReady() {
  document.body.classList.add('rt-live');
  micBtn.classList.add('live');
  muteBtn.classList.remove('hidden');
  muteBtn.classList.remove('muted');
  setMode('listening');
  // Текст, введений до натискання мікрофона — відправляємо автоматично
  const v = textInput.value.trim();
  if (v) {
    textInput.value = '';
    if (voiceEngine === 'live') sendLiveText(v);
    else sendRealtimeText(v);
  }
}

function toggleMute() {
  if (!connected) return;
  micMuted = !micMuted;
  micStream?.getAudioTracks().forEach((t) => (t.enabled = !micMuted));
  // live: офіційна подія mute для сервера
  if (voiceEngine === 'live' && dc?.readyState === 'open' && liveReady) {
    dc.send(JSON.stringify({ type: micMuted ? 'session.input_audio.mute' : 'session.input_audio.unmute' }));
  }
  muteBtn.classList.toggle('muted', micMuted);
  setMode(micMuted ? 'idle' : 'listening');
  if (micMuted) setStatus('Мікрофон вимкнено');
}

// ─── Live (GPT-Live, full-duplex) ─────────────────────────

async function connectLive() {
  setMode('thinking');
  setStatus('З’єднуюсь…');
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });

    connectCommon();
    setupMicAnalyser();

    dc.onmessage = (event) => {
      try { handleLiveEvent(JSON.parse(event.data)); } catch { /* не-JSON */ }
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitIceGathering(pc);

    // SDP-офер → наш сервер → OpenAI /v1/live/sessions → відповідь
    const res = await fetch('/api/live/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sdp: pc.localDescription?.sdp }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j.error || 'Не вдалося створити голосову сесію');
    if (!j.sdp) throw new Error('Не вдалося підʼєднатися: немає відповіді від OpenAI');

    await pc.setRemoteDescription({ type: 'answer', sdp: j.sdp });
    livePending = true;
    startStateLoop();
  } catch (e) {
    disconnectVoice();
    addBubble('error', `😿 ${e.message || 'Помилка з’єднання'}`);
    setMode('idle');
  }
}

/**
 * Події GPT-Live з каналу 'oai-events'.
 * Станів speaking/listening окремо немає — визначаємо з фрагментів
 * транскриптів + RMS мікрофона (цикл станів нижче).
 */
function handleLiveEvent(ev) {
  switch (ev.type) {
    case 'session.started':
      if (livePending) {
        livePending = false;
        liveReady = true;
        connected = true;
        onVoiceReady();
      }
      break;
    case 'session.input_transcript.delta': {
      // Фрагменти НЕ межі реплік — збираємо бульбашку, поки людина говорить
      const now = Date.now();
      if (!userBubble || !userWasActive) {
        userBubble = addBubble('user', '');
      }
      userBubble.textContent = cleanTranscript(userBubble.textContent + (ev.delta || ''));
      userWasActive = true;
      lastInputAt = now;
      scrollDown();
      break;
    }
    case 'session.output_transcript.delta': {
      const now = Date.now();
      if (!lunaBubble || !lunaWasActive) {
        lunaBubble = addBubble('luna', '');
      }
      lunaBubble.textContent = cleanTranscript(lunaBubble.textContent + (ev.delta || ''));
      lunaWasActive = true;
      lastOutputAt = now;
      scrollDown();
      break;
    }
    case 'session.closed':
      if (connected) disconnectVoice();
      break;
    case 'error':
      addBubble('error', `😿 ${ev.error?.message || 'помилка сесії'}`);
      break;
    default:
      break;
  }
}

/** Текст у live-режимі: user-повідомлення бекенду + запуск відповіді. */
function sendLiveText(text) {
  addBubble('user', text);
  userWasActive = false;
  if (dc?.readyState === 'open' && liveReady) {
    dc.send(
      JSON.stringify({
        type: 'response.item.create',
        item: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text }],
        },
      })
    );
    dc.send(JSON.stringify({ type: 'response.create' }));
  }
}

// ─── Цикл станів (live): mic RMS + decay активності ───────
// Гнучкий, повний дуплекс — "говорю/слухаю" визначаємо по факту:
//  - Луна говорить, поки приходять її transcript-фрагменти;
//  - людина говорить, поки RMS мікрофона вище порогу.
const MIC_RMS_ON = 0.015;
const STATE_GAP = 2000; // скільки ms без активності — "замовкла" (не розриває репліку)
const LUNA_TAIL = 2500; // пауза між фрагментами відповіді Луни (вона "дихає")

function startStateLoop() {
  stopStateLoop();
  stateTimer = setInterval(() => {
    if (!connected) return;
    const now = Date.now();

    // decay "на хвилі"
    if (lunaWasActive && now - lastOutputAt > LUNA_TAIL) lunaWasActive = false;
    if (userWasActive && now - lastInputAt > STATE_GAP) userWasActive = false;

    // mic RMS (якщо не вимкнено)
    let userSpeaking = false;
    if (!micMuted) {
      const rms = micRms();
      if (rms > MIC_RMS_ON) lastMicActiveAt = now;
      userSpeaking = now - lastMicActiveAt < STATE_GAP;
    }

    let target;
    if (micMuted) target = 'idle';
    else if (lunaWasActive) target = 'speaking';
    else if (userSpeaking || userWasActive) target = 'listening';
    else if (now - lastInputAt < 2500) target = 'thinking';
    else target = 'listening';
    setMode(target);

    // рот від гучності — тільки поки Луна говорить
    if (target === 'speaking') startVoiceMouth();
    else stopVoiceMouth();
  }, 250);
}

function stopStateLoop() {
  if (stateTimer) {
    clearInterval(stateTimer);
    stateTimer = 0;
  }
}

// ─── Realtime (GPT-Realtime, напівдуплекс) ────────────────

async function connectRealtime() {
  setMode('thinking');
  setStatus('З’єднуюсь…');
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });

    // Тимчасовий ключ (ek_...) та адресу підключення — з нашого сервера
    const sessionRes = await fetch('/api/realtime/session', { method: 'POST' });
    const session = await sessionRes.json();
    if (!sessionRes.ok) {
      throw new Error(session.error || 'Не вдалося створити голосову сесію');
    }

    connectCommon();
    dc.onmessage = (event) => {
      try { handleRealtimeEvent(JSON.parse(event.data)); } catch { /* не-JSON */ }
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    const answerRes = await fetch(session.connectUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${session.clientSecret}`,
        'Content-Type': 'application/sdp',
      },
      body: offer.sdp,
    });
    if (!answerRes.ok) {
      throw new Error('Не вдалося підʼєднатися до голосової моделі. Перевір доступ до Realtime API.');
    }
    await pc.setRemoteDescription({ type: 'answer', sdp: await answerRes.text() });

    connected = true;
    onVoiceReady();
  } catch (e) {
    disconnectVoice();
    addBubble('error', `😿 ${e.message || 'Помилка з’єднання'}`);
    setMode('idle');
  }
}

/**
 * Події GPT-Realtime.
 * Порядок бульбашок: на speech_stopped одразу створюємо порожню
 * бульбашку користувача — розпізнаний текст приходить ПІЗНІШЕ, ніж
 * Луна починає відповідати (response.created), інакше відповідь
 * з’являється вище за фразу.
 */
function handleRealtimeEvent(ev) {
  switch (ev.type) {
    case 'input_audio_buffer.speech_started':
      // людина заговорила (можна посеред відповіді — barge-in)
      if (mode === 'speaking' && lunaRtBubble) {
        // перебивання: залишаємо лише те, що Луна встигла сказати
        // (набрані delta), а повний текст з done не перезаписує бульбашку
        lunaRtBubble = null;
        stopVoiceMouth();
      }
      setMode('listening');
      break;
    case 'input_audio_buffer.speech_stopped':
      setMode('thinking');
      pendingUserBubble = addBubble('user', '');
      break;
    case 'conversation.item.input_audio_transcription.completed':
      if (pendingUserBubble) {
        pendingUserBubble.textContent = ev.transcript || '';
        pendingUserBubble = null;
      } else if (ev.transcript) {
        addBubble('user', ev.transcript);
      }
      break;
    case 'response.created':
      lunaRtBubble = addBubble('luna', '…');
      break;
    case 'response.output_audio_transcript.delta':
      if (!lunaRtBubble) lunaRtBubble = addBubble('luna', '');
      lunaRtBubble.textContent += ev.delta || '';
      scrollDown();
      break;
    case 'response.output_audio_transcript.done':
      // повний транскрипт — тільки якщо відповідь не перебивали
      if (lunaRtBubble && ev.transcript) lunaRtBubble.textContent = ev.transcript;
      lunaRtBubble = null;
      break;
    case 'output_audio_buffer.started':
      setMode('speaking');
      startVoiceMouth();
      break;
    case 'output_audio_buffer.stopped':
      stopVoiceMouth();
      setMode('listening');
      break;
    case 'output_audio_buffer.cleared':
      // буфер звуку скинуто (перебивання) — точно зупиняємо рот
      stopVoiceMouth();
      break;
    default:
      break;
  }
}

/** Текст у realtime-режимі — через канал подій. */
function sendRealtimeText(text) {
  addBubble('user', text);
  setMode('thinking');
  dc.send(
    JSON.stringify({
      type: 'conversation.item.create',
      item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
    })
  );
  dc.send(JSON.stringify({ type: 'response.create' }));
}

// ─── Рот за гучністю голосу Луни ──────────────────────────
// Аналізатор лише «слухає» віддалений потік (НЕ підключений до destination —
// інакше звук гратиме двічі). Відтворює <audio id="remoteAudio">.
let audioCtx = null;
let mouthAnalyser = null;
let mouthBuf = null;
let mouthRaf = 0;

function getAudioCtx() {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;
  if (!audioCtx) audioCtx = new Ctx();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

function setupMouthAnalyser(stream) {
  const ctx = getAudioCtx();
  if (!ctx || !stream) return;
  if (mouthAnalyser) {
    try { mouthAnalyser.disconnect(); } catch { /* ok */ }
  }
  mouthAnalyser = ctx.createAnalyser();
  mouthAnalyser.fftSize = 512;
  mouthBuf = new Float32Array(mouthAnalyser.fftSize);
  ctx.createMediaStreamSource(stream).connect(mouthAnalyser);
}

/** RMS віддаленого потоку (голос Луни) — 0, якщо аналізатора немає. */
function mouthRms() {
  if (!mouthAnalyser || !mouthBuf) return 0;
  mouthAnalyser.getFloatTimeDomainData(mouthBuf);
  let sum = 0;
  for (let i = 0; i < mouthBuf.length; i++) sum += mouthBuf[i] * mouthBuf[i];
  return Math.sqrt(sum / mouthBuf.length);
}

function startVoiceMouth() {
  // ВАЖЛИВО: зупиняємо попередній цикл, якщо він ще працює —
  // інакше старий rAF-цикл живе вічно і перезаписує transform рота.
  if (mouthRaf) {
    cancelAnimationFrame(mouthRaf);
    mouthRaf = 0;
  }
  dogEl.classList.add('voice-driven'); // вимикає CSS-анімацію talk
  const loop = () => {
    mouthRaf = requestAnimationFrame(loop);
    const rms = mouthRms();
    // 0.4 + rms*k: рот тремтить на тихих звуках, широко — на гучних
    const scale = Math.min(1.5, 0.4 + rms * 8);
    mouthEl.style.transform = `scaleY(${scale.toFixed(3)})`;
  };
  loop();
}

function stopVoiceMouth() {
  if (mouthRaf) {
    cancelAnimationFrame(mouthRaf);
    mouthRaf = 0;
  }
  dogEl.classList.remove('voice-driven');
  mouthEl.style.transform = '';
}

// ─── Mic RMS (live): "чи говорить людина" ─────────────────
let micAnalyser = null;
let micBuf = null;

function setupMicAnalyser() {
  const ctx = getAudioCtx();
  if (!ctx || !micStream) return;
  if (micAnalyser) {
    try { micAnalyser.disconnect(); } catch { /* ok */ }
  }
  micAnalyser = ctx.createAnalyser();
  micAnalyser.fftSize = 512;
  micBuf = new Float32Array(micAnalyser.fftSize);
  ctx.createMediaStreamSource(micStream).connect(micAnalyser);
}

function micRms() {
  if (!micAnalyser || !micBuf) return 0;
  micAnalyser.getFloatTimeDomainData(micBuf);
  let sum = 0;
  for (let i = 0; i < micBuf.length; i++) sum += micBuf[i] * micBuf[i];
  return Math.sqrt(sum / micBuf.length);
}

// ─── Керування ────────────────────────────────────────────
micBtn.addEventListener('click', () => {
  if (voiceEngine === 'off') return;
  if (connected) disconnectVoice();
  else if (voiceEngine === 'live') connectLive();
  else connectRealtime();
});

muteBtn.addEventListener('click', toggleMute);

soundBtn.addEventListener('click', () => {
  remoteAudio
    .play()
    .then(() => soundBtn.classList.add('hidden'))
    .catch(() => { /* спробуємо ще */ });
});

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const v = textInput.value.trim();
  if (!v || voiceEngine === 'off') return;
  if (connected) {
    textInput.value = '';
    if (voiceEngine === 'live') sendLiveText(v);
    else sendRealtimeText(v);
  } else {
    // з'єднання ще немає — текст збережеться і летить автоматично
    setStatus('Натисни 🎤 — текст відправиться автоматично');
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => {
      if (!connected) setMode('idle');
    }, 3000);
  }
});

document.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && e.target === document.body) {
    e.preventDefault();
    micBtn.click();
  }
});

// ─── Старт: визначаємо режим ──────────────────────────────
(async () => {
  let h = null;
  try {
    h = await fetch('/api/health').then((r) => r.json());
  } catch { /* офлайн */ }

  voiceEngine = h?.mode === 'live' || h?.mode === 'realtime' ? h.mode : 'off';
  if (h) {
    metaEl.textContent =
      voiceEngine === 'live'
        ? `${h.provider} · GPT-Live (full-duplex)`
        : voiceEngine === 'realtime'
          ? `${h.provider} · realtime (WebRTC)`
          : `${h.provider} · голос вимкнено`;
  } else {
    metaEl.textContent = 'офлайн';
  }

  if (voiceEngine === 'off') {
    addBubble('error', 'Голосовий рушій не підтримується поточною конфігурацією (перевір OPENAI_BASE_URL у .env).');
    micBtn.disabled = true;
    return;
  }

  document.body.classList.add('rt-mode');
  addBubble(
    'luna',
    voiceEngine === 'live'
      ? 'Гав! Я Луна — твій лабрадор-асистент. Натисни мікрофон і поговорімо — я можу слухати тебе, поки сама говорю! 🐾'
      : 'Гав! Я Луна — твій лабрадор-асистент. Натисни мікрофон і поговорімо голосом! 🐾'
  );
})();
