# 🔮 Holo Assist — Electron Desktop App

A floating AI meeting assistant overlay that works on top of **any** meeting app:
Zoom desktop, Google Meet, Microsoft Teams, Webex — anything.

---

## How It Works

```
You open Zoom / Meet / Teams as normal
         ↓
Holo Assist floats on top as a small overlay
         ↓
Select audio source (screen audio or microphone)
         ↓
Click "Start Listening"
         ↓
hark detects speech → MediaRecorder captures chunks
         ↓
Chunks → your Deepgram transcription API
         ↓
Claude generates live insights
         ↓
Summary cards appear in real time
         ↓
Chat with Holo anytime during the meeting
```

---

## Project Structure

```
holo-electron/
├── main.js          ← Electron main process (window, IPC, desktopCapturer)
├── preload.js       ← Secure bridge between main and renderer
├── renderer/
│   ├── index.html   ← Overlay UI shell
│   └── app.js       ← ALL assistant logic (transcription, insights, chat, TTS)
└── package.json
```

---

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Run in development

```bash
npm start
```

### 3. Build for distribution

```bash
npm run build
```

This produces:
- `dist/Holo Assist.dmg` for Mac
- `dist/Holo Assist Setup.exe` for Windows

---

## macOS Permissions (IMPORTANT)

On macOS, system audio capture requires a virtual audio driver.
The app will ask for **Screen Recording** permission on first launch.

For system audio (hearing Zoom/Teams audio), users need to install
**BlackHole** (free) or **Loopback**:

```
https://existential.audio/blackhole/
```

Then in System Settings → Sound → Output, route audio through BlackHole.
Select BlackHole as the audio source in Holo Assist.

**Alternatively** — microphone mode works out of the box and picks up
the user's voice perfectly. Many users prefer this for privacy.

---

## Windows Permissions

Windows allows system audio capture natively via WASAPI loopback.
No extra drivers needed. The app will show all audio outputs in the dropdown.

---

## Key Files to Know

### main.js
- Creates the always-on-top frameless window
- Handles `desktopCapturer` to list all screens/windows
- IPC handlers for window drag, minimize, close

### renderer/app.js
- `startSession()` — gets audio stream (mic or system)
- `startVoiceDetection()` — hark VAD, identical to your LiveKit useEffect
- `startRecordingChunk()` / `stopRecordingChunk()` — MediaRecorder logic
- `sendChunkToBackend()` — posts to your `/api/ai-assistant/transcribe-live`
- `addInsightCard()` — renders live summary cards
- `sendChat()` — posts to your `/api/ai-assistant`
- `speakText()` — calls your TTS endpoint

### All backend URLs (change these if your API moves)
```js
// renderer/app.js top of file
const API_TRANSCRIBE = 'https://holovox-nextjs.vercel.app/api/ai-assistant/transcribe-live';
const API_ASSISTANT  = 'https://holovox-nextjs.vercel.app/api/ai-assistant';
const API_TTS        = 'https://holovox-nextjs.vercel.app/api/ai-assistant/voice';
```

---

## User ID / Persona

The app uses `localStorage` to persist a `holo_user_id`.
This is sent with every request so Claude loads the user's assistant persona
(same as your existing `AssistantInfo` MongoDB lookup).

If the user has set up their assistant on your web app, it will
automatically carry over here because it's keyed by the same userId.

---

## What's Different vs Your LiveKit Version

| Feature | LiveKit (web) | Electron overlay |
|---|---|---|
| Audio source | Per-participant track | Mixed system/mic audio |
| Speaker ID | Per participant | "Host" (or add diarization) |
| Works on | Your rooms only | ANY meeting app |
| Always on top | No | Yes |
| Desktop Zoom | No | ✅ |
| Backend changes | — | Zero |

---

## Adding Deepgram Speaker Diarization

To get speaker names even in mixed audio, add `diarize: true` to your
transcribe API call in `/api/ai-assistant/transcribe-live`:

```js
const { result } = await deepgram.listen.prerecorded.transcribeFile(buffer, {
  model: 'nova-2',
  smart_format: true,
  language: 'en',
  diarize: true,        // ← add this
});
```

Deepgram will return `speaker_0`, `speaker_1` etc. automatically.

---

## Chrome Extension (Phase 2)

The renderer code (`app.js`) is intentionally written in vanilla JS
so it can be reused in a Chrome extension with minimal changes.

For the extension, replace:
- `window.holoAPI.getAudioSources()` → `chrome.tabCapture.capture()`
- `desktopCapturer` → `chrome.tabCapture` API
- The rest stays identical.
