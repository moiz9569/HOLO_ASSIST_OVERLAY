// ─────────────────────────────────────────────────────────────────────────────
// HOLO ASSIST — app.js
// ─────────────────────────────────────────────────────────────────────────────

const API_TRANSCRIBE =
  "https://holovox-nextjs-server.vercel.app/api/ai-assistant/transcribe-live";
const API_ASSISTANT =
  "https://holovox-nextjs-server.vercel.app/api/ai-assistant";
const API_TTS =
  "https://holovox-nextjs-server.vercel.app/api/ai-assistant/voice";

// ── STATE ────────────────────────────────────────────────────────────────────
let isListening = false;
let mediaStream = null;
let mediaRecorder = null;
let audioChunks = [];
let currentSessionSource = "mic";
let silenceTimeout = null;
let speechDetector = null;
let sessionStartTime = null;
let sessionTimer = null;
let totalWords = 0;
let insightCount = 0;
let isSpeaking = false;
let openCardData = null;
let currentUserId = getUserId();

const chatHistory = [
  {
    from: "holo",
    text: "Hi! I'm Holo — your AI meeting assistant. Start a session to get live insights, or ask me anything right now.",
  },
];

// ── USER ID ──────────────────────────────────────────────────────────────────
function getUserId() {
  let id = localStorage.getItem("holo_user_id");
  if (!id) {
    id = "holo_" + Math.random().toString(36).slice(2, 10);
    localStorage.setItem("holo_user_id", id);
  }
  return id;
}

// ── TOAST ────────────────────────────────────────────────────────────────────
function showToast(msg, ms = 2800) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.add("show");
  setTimeout(() => el.classList.remove("show"), ms);
}

// ── TABS ─────────────────────────────────────────────────────────────────────
function switchTab(name) {
  document
    .querySelectorAll(".tab")
    .forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
  document
    .querySelectorAll(".tab-panel")
    .forEach((p) => p.classList.toggle("active", p.id === `panel-${name}`));
}

document
  .querySelectorAll(".tab")
  .forEach((tab) =>
    tab.addEventListener("click", () => switchTab(tab.dataset.tab)),
  );

// ── WINDOW DRAG ──────────────────────────────────────────────────────────────
let isDragging = false,
  dragStartX = 0,
  dragStartY = 0;

document.getElementById("titlebar").addEventListener("mousedown", (e) => {
  if (e.target.classList.contains("ctrl-btn")) return;
  isDragging = true;
  dragStartX = e.screenX;
  dragStartY = e.screenY;
});

document.addEventListener("mousemove", (e) => {
  if (!isDragging) return;
  window.holoAPI.dragWindow({
    deltaX: e.screenX - dragStartX,
    deltaY: e.screenY - dragStartY,
  });
  dragStartX = e.screenX;
  dragStartY = e.screenY;
});

document.addEventListener("mouseup", () => {
  isDragging = false;
});

// ── MAC BLACKHOLE BANNER ──────────────────────────────────────────────────────
if (window.holoAPI.platform === "darwin") {
  window.holoAPI.onMacNeedsBlackHole(() => {
    document.getElementById("mac-banner").classList.add("visible");
  });

  document
    .getElementById("bh-install-btn")
    .addEventListener("click", async () => {
      await window.holoAPI.installBlackHole();
      showToast("Opening BlackHole download page…");
      // Poll for install completion
      const check = setInterval(async () => {
        const { installed } = await window.holoAPI.recheckBlackHole();
        if (installed) {
          clearInterval(check);
          document.getElementById("mac-banner").classList.remove("visible");
          showToast("BlackHole installed! Full audio capture enabled ✅");
          loadSources();
        }
      }, 5000);
    });

  document.getElementById("bh-dismiss-btn").addEventListener("click", () => {
    document.getElementById("mac-banner").classList.remove("visible");
  });
}

// ── AUDIO SOURCES ────────────────────────────────────────────────────────────
async function loadSources() {
  try {
    const sources = await window.holoAPI.getAudioSources();
    const sel = document.getElementById("source-select");
    sel.innerHTML = '<option value="mic">Microphone only</option>';

    sources.forEach((src) => {
      const opt = document.createElement("option");
      opt.value = src.id;
      const label =
        src.name.length > 40 ? src.name.slice(0, 38) + "..." : src.name;
      opt.textContent = `Entire screen - ${label}`;
      sel.appendChild(opt);
    });
  } catch (e) {
    console.warn("loadSources error:", e);
  }
}

loadSources();

// ── START SESSION ────────────────────────────────────────────────────────────
async function startSession() {
  const sourceId = document.getElementById("source-select").value;

  try {
    let stream;

    if (sourceId === "mic") {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: false,
      });
    } else {
      // Desktop/window capture — needs video constraint for Electron desktopCapturer
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          mandatory: {
            chromeMediaSource: "desktop",
            chromeMediaSourceId: sourceId,
          },
        },
        video: {
          mandatory: {
            chromeMediaSource: "desktop",
            chromeMediaSourceId: sourceId,
          },
        },
      });
      // Drop video — we only need audio
      stream.getVideoTracks().forEach((t) => t.stop());
    }

    mediaStream = stream;
    currentSessionSource = sourceId === "mic" ? "mic" : "screen";
    isListening = true;

    startVoiceDetection(stream);
    updateSessionUI(true);

    sessionStartTime = Date.now();
    updateBrainTimer(0);
    sessionTimer = setInterval(() => {
      const secs = Math.floor((Date.now() - sessionStartTime) / 1000);
      updateBrainTimer(secs);
    }, 1000);

    showToast("Holo is now listening 🎙️");

    /////////////////////////////////////////////////////////////////////////
    const btn = document.getElementById("brief-mic-btn");

    btn.classList.add("listening");
    btn.setAttribute("aria-label", "Stop listening");

    /////////////////////////////////////////////////////////////////
  } catch (err) {
    console.error("startSession error:", err);
    const msg =
      err.name === "NotAllowedError"
        ? "Permission denied. Allow microphone access and try again."
        : "Could not access audio: " + err.message;
    showToast(msg, 4000);
  }
}

////////////////////////////////////////////////////////////////////////////////////////////
async function toggleListening() {
  if (isListening) {
    await stopSession();
  } else {
    await startSession();
  }
}
/////////////////////////////////////////////////////////////////////////////////////////////////////////

// ── STOP SESSION ─────────────────────────────────────────────────────────────
async function stopSession() {
  isListening = false;

  if (speechDetector) {
    try {
      speechDetector.stop();
    } catch (_) {}
    speechDetector = null;
  }

  if (silenceTimeout) {
    clearTimeout(silenceTimeout);
    silenceTimeout = null;
  }
  stopRecordingChunk();

  if (mediaStream) {
    mediaStream.getTracks().forEach((t) => t.stop());
    mediaStream = null;
  }

  if (sessionTimer) {
    clearInterval(sessionTimer);
    sessionTimer = null;
  }

  updateBrainTimer(0);
  updateSessionUI(false);
  showToast("Session stopped");

  ///////////////////////////////////////////////////////////////////////////////
  const btn = document.getElementById("brief-mic-btn");

  btn.classList.remove("listening");
  btn.setAttribute("aria-label", "Start listening");
  ///////////////////////////////////////////////////////////////////////////////////
  loadSources();
}

function updateSessionUI(active) {
  document.getElementById("status-icon").textContent = active ? "🔴" : "🎙️";
  document.getElementById("status-title").textContent = active
    ? "Listening…"
    : "Session ended";

  if (active) {
    document.getElementById("status-sub").innerHTML =
      '<span class="rec-badge"><span class="rec-dot"></span> Recording</span>';
  } else {
    document.getElementById("status-sub").textContent =
      `${insightCount} insight${insightCount !== 1 ? "s" : ""} captured`;
  }

  const startBtn = document.getElementById("start-btn");
  if (startBtn) startBtn.style.display = active ? "none" : "block";

  const sourceWrap = document.getElementById("source-wrap");
  if (sourceWrap) sourceWrap.style.display = "block";

  const sourceSelect = document.getElementById("source-select");
  if (sourceSelect) sourceSelect.disabled = active;

  document.getElementById("live-dot").classList.toggle("active", active);
}

function fmtDuration(secs) {
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function updateBrainTimer(secs) {
  const progress = document.getElementById("brain-ring-progress");
  const label = document.getElementById("brain-percent");
  const duration = fmtDuration(secs);

  if (label) label.textContent = duration;
  if (!progress) return;

  const radius = Number(progress.getAttribute("r")) || 54;
  const circumference = 2 * Math.PI * radius;
  const minuteProgress = (secs % 60) / 60;

  progress.style.strokeDasharray = `${circumference}`;
  progress.style.strokeDashoffset = `${circumference * (1 - minuteProgress)}`;
}

// ── VOICE DETECTION (hark) ───────────────────────────────────────────────────
function startVoiceDetection(stream) {
  const events = hark(stream, { interval: 80, threshold: -65 });
  speechDetector = events;

  events.on("speaking", () => {
    if (silenceTimeout) {
      clearTimeout(silenceTimeout);
      silenceTimeout = null;
    }
    startRecordingChunk();
  });

  events.on("stopped_speaking", () => {
    if (silenceTimeout) clearTimeout(silenceTimeout);
    silenceTimeout = setTimeout(stopRecordingChunk, 3000);
  });
}

// ── RECORDING CHUNKS ─────────────────────────────────────────────────────────
function getRecorderOptions() {
  const preferred = "audio/webm;codecs=opus";
  if (window.MediaRecorder?.isTypeSupported?.(preferred)) {
    return { mimeType: preferred };
  }

  return {};
}

function startRecordingChunk() {
  if (mediaRecorder?.state === "recording") return;
  if (!mediaStream) return;

  audioChunks = [];
  mediaRecorder = new MediaRecorder(mediaStream, getRecorderOptions());

  mediaRecorder.ondataavailable = (e) => {
    if (e.data.size > 0) audioChunks.push(e.data);
  };

  mediaRecorder.onstop = async () => {
    const blob = new Blob(audioChunks, { type: "audio/webm" });
    console.log("recording chunk stopped", { size: blob.size });
    if (blob.size < 3000) {
      console.log("chunk too small, ignoring");
      return;
    }
    await sendChunkToBackend(blob);
  };

  mediaRecorder.start();
}

function stopRecordingChunk() {
  if (mediaRecorder?.state === "recording") mediaRecorder.stop();
}

// ── SEND CHUNK TO BACKEND ────────────────────────────────────────────────────
async function sendChunkToBackend(blob) {
  try {
    console.log("sendChunkToBackend: uploading chunk", {
      size: blob.size,
      userId: currentUserId,
    });
    const fd = new FormData();
    fd.append("audio", blob, "audio.webm");
    fd.append("roomId", "electron-session");
    fd.append("participantId", currentUserId);
    fd.append("participantName", "Host");
    fd.append("userId", currentUserId);

    const res = await fetch(API_TRANSCRIBE, { method: "POST", body: fd });
    console.log(
      "sendChunkToBackend: fetch returned",
      res.status,
      res.statusText,
    );
    const data = await res.json();
    console.log("sendChunkToBackend: response data", data);

    if (data.text) {
      totalWords += data.text.trim().split(/\s+/).length;
      document.getElementById("stat-words").textContent = totalWords;
    } else {
      console.log("sendChunkToBackend: no text in response");
    }

    if (data.summary) {
      addInsightCard({ text: data.summary, type: data.type || "summary" });
    } else {
      console.log("sendChunkToBackend: no summary in response");
    }
  } catch (err) {
    console.error("sendChunk error:", err);
  }
}

// ── INSIGHT CARDS ─────────────────────────────────────────────────────────────
function addInsightCard({ text, type }) {
  insightCount++;
  const id = Date.now().toString();

  // Update counters
  document.getElementById("stat-insights").textContent = insightCount;
  const badge = document.getElementById("insight-badge");
  badge.textContent = insightCount;
  badge.style.display = "inline";

  // Hide empty state
  document.getElementById("insights-empty").style.display = "none";

  // Build card
  const list = document.getElementById("insights-list");
  const card = document.createElement("div");
  card.className = "insight-card";
  card.id = `card-${id}`;
  card.style.cssText = "margin-bottom:8px;";
  card.innerHTML = `
    <button class="insight-dismiss" onclick="dismissCard('${id}',event)">×</button>
    <div class="insight-type">${type === "answer" ? "💬 Question Answered" : "✨ Live Insight"}</div>
    <div class="insight-text">${escHtml(text)}</div>
    <div class="insight-hint">Tap to expand</div>
  `;
  card.addEventListener("click", () => openInsightModal({ id, text, type }));
  list.prepend(card);
  console.log("addInsightCard: insight added", { id, type, text });

  // Auto-switch to insights tab if on session
  if (document.querySelector(".tab.active")?.dataset.tab === "session") {
    switchTab("insights");
  }
}

function dismissCard(id, e) {
  e?.stopPropagation();
  document.getElementById(`card-${id}`)?.remove();
  insightCount = Math.max(0, insightCount - 1);
  document.getElementById("stat-insights").textContent = insightCount;
  const badge = document.getElementById("insight-badge");
  if (insightCount === 0) {
    badge.style.display = "none";
  } else {
    badge.textContent = insightCount;
  }
}

function openInsightModal({ id, text, type }) {
  openCardData = { id, text, type };
  document.getElementById("modal-type").textContent =
    type === "answer" ? "💬 Question Answered" : "✨ Live Insight";
  document.getElementById("modal-text").textContent = text;
  document.getElementById("insight-modal").classList.add("open");
}

function closeModal(sendToChat) {
  if (sendToChat && openCardData) {
    addChatMessage({ from: "holo", text: openCardData.text });
    dismissCard(openCardData.id, null);
    switchTab("chat");
  }
  openCardData = null;
  document.getElementById("insight-modal").classList.remove("open");
}

// ── CHAT ─────────────────────────────────────────────────────────────────────
function renderChat() {
  const container = document.getElementById("chat-messages");
  container.innerHTML = "";

  chatHistory.forEach((msg) => {
    const row = document.createElement("div");
    row.className = `msg-row from-${msg.from}`;

    const bubble = document.createElement("div");
    bubble.className = "msg-bubble";
    if (msg.isLoading) {
      bubble.innerHTML = '<span style="opacity:.5">…</span>';
    } else {
      const prefix = document.createElement("span");
      prefix.className = "msg-prefix";
      prefix.textContent = msg.from === "holo" ? "HOLOVOX: " : "YOU: ";
      bubble.appendChild(prefix);
      bubble.appendChild(document.createTextNode(msg.text));
    }

    row.appendChild(bubble);

    if (msg.from === "holo" && !msg.isLoading) {
      const btn = document.createElement("button");
      btn.className = "speak-btn";
      btn.setAttribute("aria-label", "Speak");
      btn.title = "Speak";
      const icon = document.createElement("img");
      icon.src = "../assets/speaker-2-svgrepo-com.svg";
      icon.alt = "";
      btn.appendChild(icon);
      btn.disabled = isSpeaking;
      btn.onclick = () => speakText(msg.text);
      row.appendChild(btn);
    }

    container.appendChild(row);
  });

  container.scrollTop = container.scrollHeight;
}

function addChatMessage(msg) {
  chatHistory.push(msg);
  renderChat();
}

// Initial render
renderChat();

function handleChatKey(e) {
  if (e.key === "Enter") sendChat();
}

async function sendChat() {
  const input = document.getElementById("chat-input");
  const text = input.value.trim();
  if (!text) return;
  input.value = "";

  addChatMessage({ from: "you", text });
  addChatMessage({ from: "holo", text: "Thinking…", isLoading: true });

  try {
    const fd = new FormData();
    fd.append("userId", currentUserId);
    fd.append("message", text);

    const res = await fetch(API_ASSISTANT, { method: "POST", body: fd });
    const data = await res.json();

    const idx = chatHistory.findLastIndex((m) => m.isLoading);
    if (idx !== -1) chatHistory.splice(idx, 1);

    addChatMessage({ from: "holo", text: data.reply || "No response." });
  } catch (err) {
    const idx = chatHistory.findLastIndex((m) => m.isLoading);
    if (idx !== -1) chatHistory.splice(idx, 1);
    addChatMessage({ from: "holo", text: "Error connecting to Holo server." });
  }
}

// ── TEXT TO SPEECH ────────────────────────────────────────────────────────────
async function speakText(text) {
  if (!text?.trim() || isSpeaking) return;
  isSpeaking = true;
  renderChat();

  try {
    const res = await fetch(API_TTS, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });

    if (!res.ok) throw new Error("TTS failed");

    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);

    const cleanup = () => {
      isSpeaking = false;
      URL.revokeObjectURL(url);
      renderChat();
    };
    audio.onended = cleanup;
    audio.onerror = cleanup;
    await audio.play();
  } catch (err) {
    console.error("TTS error:", err);
    isSpeaking = false;
    renderChat();
  }
}

// ── UTILS ─────────────────────────────────────────────────────────────────────
function escHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
