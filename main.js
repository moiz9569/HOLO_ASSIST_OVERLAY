// HOLO ASSIST - main.js
// Electron main process
// Responsibilities:
//   - Create and manage bubble and panel windows
//   - Detect active Zoom and Google Meet sessions and show/hide the bubble
//   - Provide IPC bridge to renderer
//   - Handle system audio driver checks on macOS (BlackHole)

const {
  app, BrowserWindow, ipcMain, desktopCapturer,
  screen, shell,
} = require('electron');
const path = require('path');
const fs = require('fs');
const { exec, execFile } = require('child_process');

let bubbleWindow = null;
let panelWindow = null;
let forceQuit = false;
let meetingActive = false;
let meetingWatcher = null;
let meetingWatchInFlight = false;
let missedMeetingChecks = 0;
let userHiddenBubble = false;
let manualUiVisible = false;
let pendingManualUi = false;
let lastMeetingMatchKey = null;
let lastNoMeetingLogAt = 0;
const warnedProbeFailures = new Set();

const START_HIDDEN_ARG = '--background';
const launchedInBackground = process.argv.includes(START_HIDDEN_ARG);
const MEETING_CHECK_INTERVAL_MS = 1500;
const MEETING_MISSED_CHECKS_BEFORE_HIDE = 4;
const STARTUP_MEETING_CHECK_DELAYS_MS = [250, 1000, 2500, 5000, 9000];

const log = {
  info: (...args) => console.log('[HOLO]', ...args),
  warn: (...args) => console.warn('[HOLO]', ...args),
  error: (...args) => console.error('[HOLO]', ...args),
};

function normalizeTitle(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function isZoomProcessName(processName) {
  return /^(zoom|zoom\.us|cptHost|zoomcm|zoom rooms)$/i.test(String(processName || ''));
}

function isBrowserProcessName(processName) {
  return /^(chrome|msedge|firefox|brave|opera|safari|vivaldi|google chrome|microsoft edge|brave browser)$/i.test(String(processName || ''));
}

function isTeamsProcessName(processName) {
  return /^(teams|msteams|ms-teams|microsoft teams)$/i.test(String(processName || ''));
}

function isWebexProcessName(processName) {
  return /^(webex|ciscowebexstart|atmgr|webexmta)$/i.test(String(processName || ''));
}

function isZoomMeetingTitle(rawTitle, processName = '') {
  const title = normalizeTitle(rawTitle);
  const lower = title.toLowerCase();
  const fromZoomProcess = isZoomProcessName(processName);

  if (/\b(zoom meeting|zoom webinar|meeting controls|zoom workplace.*meeting|zoom rooms)\b/i.test(title)) {
    return true;
  }
  if (fromZoomProcess && /\b(meeting|webinar|personal meeting room|waiting room|breakout room|screen sharing|share screen)\b/i.test(title)) {
    return true;
  }

  return lower.includes('zoom') && /\b(meeting|webinar|room|screen sharing|share screen)\b/i.test(title);
}

function isGoogleMeetTitle(rawTitle, processName = '') {
  const title = normalizeTitle(rawTitle);
  const lower = title.toLowerCase();
  const looksLikeMeetHomePage = /\b(online video calls|video conferencing|premium video meetings|help|settings)\b/i.test(title);

  if (lower.includes('meet.google.com')) return true;
  if (lower.includes('google meet') && !looksLikeMeetHomePage) {
    return true;
  }
  if (isBrowserProcessName(processName) && /\bmeet\s*[-|:]\s*.+/i.test(title)) return true;
  if (isBrowserProcessName(processName) && /.+\s+-\s+meet$/i.test(title)) return true;
  if (isBrowserProcessName(processName) && /.+\s+-\s+google meet$/i.test(title)) return true;
  if (isBrowserProcessName(processName) && /\b[a-z]{3}-[a-z]{4}-[a-z]{3}\b/i.test(title)) return true;

  return false;
}

function isTeamsMeetingTitle(rawTitle, processName = '') {
  const title = normalizeTitle(rawTitle);
  const lower = title.toLowerCase();

  if (lower.includes('teams.microsoft.com') && /\b(meet|meeting|call)\b/i.test(title)) return true;
  if (/\b(microsoft teams meeting|teams meeting|teams call)\b/i.test(title)) return true;
  if (isTeamsProcessName(processName) && /\b(meeting|call|screen sharing|share tray)\b/i.test(title)) return true;

  return false;
}

function isWebexMeetingTitle(rawTitle, processName = '') {
  const title = normalizeTitle(rawTitle);
  const lower = title.toLowerCase();

  if (lower.includes('webex.com') && /\b(meet|meeting|webinar)\b/i.test(title)) return true;
  if (/\b(webex meeting|cisco webex|webex webinar)\b/i.test(title)) return true;
  if (isWebexProcessName(processName) && /\b(meeting|webinar|sharing)\b/i.test(title)) return true;

  return false;
}

function getMeetingMatch(source, origin) {
  const title = normalizeTitle(typeof source === 'string' ? source : source?.name || source?.title);
  const processName = normalizeTitle(typeof source === 'string' ? '' : source?.processName);
  if (!title) return null;

  if (isZoomMeetingTitle(title, processName)) {
    return { provider: 'zoom', title, origin };
  }
  if (isGoogleMeetTitle(title, processName)) {
    return { provider: 'google-meet', title, origin };
  }
  if (isTeamsMeetingTitle(title, processName)) {
    return { provider: 'teams', title, origin };
  }
  if (isWebexMeetingTitle(title, processName)) {
    return { provider: 'webex', title, origin };
  }

  return null;
}

async function getDesktopCapturerMeetingMatch() {
  const sources = await desktopCapturer.getSources({
    types: ['window'],
    fetchWindowIcons: false,
    thumbnailSize: { width: 0, height: 0 },
  });

  return sources.map((source) => getMeetingMatch(source, 'desktopCapturer')).find(Boolean) || null;
}

function execFileText(command, args, options = {}) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 5000, windowsHide: true, ...options }, (err, stdout, stderr) => {
      if (err) {
        const warningKey = `${command}:${err.code || err.message || err}`;
        if (!warnedProbeFailures.has(warningKey)) {
          warnedProbeFailures.add(warningKey);
          log.warn('window title probe failed:', command, err.message || err);
          if (stderr) log.warn('window title probe stderr:', stderr.trim());
        }
        resolve('');
        return;
      }
      resolve(stdout || '');
    });
  });
}

async function getWindowsProcessMeetingMatch() {
  const script = [
    "$names = @('Zoom','CptHost','ZoomCM','chrome','msedge','firefox','brave','opera','vivaldi','Teams','ms-teams','MSTeams','Webex','CiscoWebexStart');",
    'Get-Process -ErrorAction SilentlyContinue |',
    'Where-Object { $names -contains $_.ProcessName -and $_.MainWindowTitle } |',
    'ForEach-Object { $_.ProcessName + [char]9 + $_.MainWindowTitle }',
  ].join(' ');

  const output = await execFileText('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    script,
  ]);

  return output
    .split(/\r?\n/)
    .map((line) => {
      const [processName, ...titleParts] = line.split('\t');
      return { processName, title: titleParts.join('\t') };
    })
    .map((source) => getMeetingMatch(source, 'win32-process-title'))
    .find(Boolean) || null;
}

async function getMacWindowMeetingMatch() {
  const script = [
    'tell application "System Events"',
    'set appNames to {"zoom.us", "Zoom Workplace", "Google Chrome", "Microsoft Edge", "Firefox", "Brave Browser", "Safari", "Microsoft Teams", "Webex"}',
    'set out to ""',
    'repeat with appName in appNames',
    'if exists process appName then',
    'repeat with w in windows of process appName',
    'try',
    'set out to out & appName & tab & name of w & linefeed',
    'end try',
    'end repeat',
    'end if',
    'end repeat',
    'return out',
    'end tell',
  ].join('\n');

  const output = await execFileText('osascript', ['-e', script]);
  return output
    .split(/\r?\n/)
    .map((line) => {
      const [processName, ...titleParts] = line.split('\t');
      return { processName, title: titleParts.join('\t') };
    })
    .map((source) => getMeetingMatch(source, 'darwin-window-title'))
    .find(Boolean) || null;
}

async function getLinuxWindowMeetingMatch() {
  const output = await execFileText('wmctrl', ['-l']);
  return output
    .split(/\r?\n/)
    .map((line) => line.replace(/^0x[0-9a-f]+\s+\S+\s+/i, ''))
    .map((title) => getMeetingMatch(title, 'linux-window-title'))
    .find(Boolean) || null;
}

async function detectActiveMeeting() {
  const detectors = [getDesktopCapturerMeetingMatch];

  if (process.platform === 'win32') detectors.push(getWindowsProcessMeetingMatch);
  if (process.platform === 'darwin') detectors.push(getMacWindowMeetingMatch);
  if (process.platform === 'linux') detectors.push(getLinuxWindowMeetingMatch);

  for (const detector of detectors) {
    try {
      const match = await detector();
      if (match) return match;
    } catch (err) {
      log.warn('meeting detector failed:', detector.name, err.message || err);
    }
  }

  return null;
}

function sendMeetingState(active, match = null) {
  for (const win of [bubbleWindow, panelWindow]) {
    if (!win || win.isDestroyed()) continue;
    win.webContents.send('meeting-state', active, match);
  }
}

function getMeetingMatchKey(match) {
  if (!match) return null;
  return `${match.provider}:${match.title}`;
}

function positionPanelBesideBubble() {
  if (!panelWindow || panelWindow.isDestroyed()) return;
  const bubbleBounds = bubbleWindow?.getBounds() || { x: 348, y: 40 };
  panelWindow.setPosition(Math.max(0, bubbleBounds.x - 340 - 8), bubbleBounds.y);
}

function showManualUi(reason = 'manual launch') {
  manualUiVisible = true;
  userHiddenBubble = false;

  if (!bubbleWindow || bubbleWindow.isDestroyed()) {
    pendingManualUi = true;
    log.warn('manual UI requested before bubble window was available');
    return;
  }

  bubbleWindow.show();

  if (!panelWindow || panelWindow.isDestroyed()) {
    createPanel();
  }

  positionPanelBesideBubble();
  panelWindow?.show();
  sendMeetingState(meetingActive);
  log.info('manual UI shown:', reason);
}

function showBubbleForMeeting(match) {
  userHiddenBubble = false;
  lastMeetingMatchKey = getMeetingMatchKey(match);

  if (!bubbleWindow || bubbleWindow.isDestroyed()) {
    log.warn('meeting detected before bubble window was available');
    return;
  }

  bubbleWindow.show();
  log.info('meeting started:', match.provider, `(${match.origin})`, match.title);
  sendMeetingState(true, match);
}

function hideMeetingWindows(reason) {
  bubbleWindow?.hide();
  panelWindow?.hide();
  manualUiVisible = false;
  lastMeetingMatchKey = null;
  log.info('meeting ended:', reason);
  sendMeetingState(false);
}

function setMeetingActive(active, match = null) {
  if (active) {
    missedMeetingChecks = 0;
    const matchKey = getMeetingMatchKey(match);

    if (!meetingActive) {
      meetingActive = true;
      showBubbleForMeeting(match);
      return;
    }

    if (matchKey && matchKey !== lastMeetingMatchKey) {
      log.info('meeting window changed:', match.provider, `(${match.origin})`, match.title);
      lastMeetingMatchKey = matchKey;
    }

    sendMeetingState(true, match);
    if (!manualUiVisible && (!bubbleWindow || !bubbleWindow.isVisible())) {
      bubbleWindow?.show();
      log.info('meeting still active; restored bubble visibility');
    } else if (!userHiddenBubble) {
      bubbleWindow?.show();
    }
    return;
  }

  const now = Date.now();
  if (!meetingActive) {
    if (now - lastNoMeetingLogAt > 15000) {
      log.info('no active meeting window detected');
      lastNoMeetingLogAt = now;
    }
    return;
  }

  missedMeetingChecks += 1;
  if (missedMeetingChecks < MEETING_MISSED_CHECKS_BEFORE_HIDE) {
    log.info('meeting not found; waiting before hiding', `${missedMeetingChecks}/${MEETING_MISSED_CHECKS_BEFORE_HIDE}`);
    return;
  }

  meetingActive = false;
  missedMeetingChecks = 0;
  userHiddenBubble = false;
  lastMeetingMatchKey = null;

  if (manualUiVisible) {
    log.info('meeting ended; keeping manually opened UI visible');
    sendMeetingState(false);
    return;
  }

  hideMeetingWindows('no Zoom or Google Meet meeting window detected');
}

function configureAutoLaunch() {
  try {
    const loginSettings = {
      openAtLogin: true,
      openAsHidden: true,
      name: 'Holo Assist',
    };

    if (process.defaultApp) {
      loginSettings.path = process.execPath;
      loginSettings.args = [app.getAppPath(), START_HIDDEN_ARG];
    } else {
      loginSettings.args = [START_HIDDEN_ARG];
    }

    app.setLoginItemSettings(loginSettings);

    const currentSettings = app.getLoginItemSettings();
    log.info('startup registration:', currentSettings.openAtLogin ? 'enabled' : 'disabled');
  } catch (err) {
    log.error('failed to configure startup registration:', err);
  }
}

// Prevent second instance.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.exit(0);
} else {
  app.on('second-instance', () => {
    showManualUi('second-instance launch');
  });
}

function createBubble() {
  const { width: sw } = screen.getPrimaryDisplay().workAreaSize;

  bubbleWindow = new BrowserWindow({
    width: 64,
    height: 64,
    x: sw - 90,
    y: 40,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    hasShadow: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  bubbleWindow.loadFile(path.join(__dirname, 'renderer', 'bubble.html')).catch((err) => {
    log.error('failed to load bubble window:', err);
  });
  bubbleWindow.setAlwaysOnTop(true, 'screen-saver');
  bubbleWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  bubbleWindow.on('close', (e) => {
    if (!forceQuit) {
      e.preventDefault();
      quitApp();
    }
  });

  bubbleWindow.webContents.on('did-fail-load', (_event, code, description) => {
    log.error('bubble window failed to load:', code, description);
  });
}

function createPanel() {
  const bubbleBounds = bubbleWindow?.getBounds() || { x: 90, y: 40 };

  panelWindow = new BrowserWindow({
    width: 340,
    height: 620,
    minWidth: 340,
    maxWidth: 340,
    minHeight: 400,
    x: Math.max(0, bubbleBounds.x - 340 - 8),
    y: bubbleBounds.y,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    hasShadow: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  panelWindow.loadFile(path.join(__dirname, 'renderer', 'index.html')).catch((err) => {
    log.error('failed to load panel window:', err);
  });
  panelWindow.setAlwaysOnTop(true, 'screen-saver');
  panelWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  panelWindow.on('close', (e) => {
    if (!forceQuit) {
      e.preventDefault();
      quitApp();
    }
  });

  panelWindow.webContents.on('did-fail-load', (_event, code, description) => {
    log.error('panel window failed to load:', code, description);
  });

  if (process.platform === 'darwin') {
    panelWindow.webContents.once('did-finish-load', checkBlackHole);
  }
}

function stopMeetingWatcher() {
  if (!meetingWatcher) return;
  clearInterval(meetingWatcher);
  meetingWatcher = null;
  meetingWatchInFlight = false;
}

function quitApp() {
  forceQuit = true;
  stopMeetingWatcher();
  bubbleWindow?.destroy();
  panelWindow?.destroy();
  app.exit(0);
}

function togglePanel() {
  if (!panelWindow || panelWindow.isDestroyed()) {
    createPanel();
  }

  if (panelWindow.isVisible()) {
    panelWindow.hide();
    return;
  }

  positionPanelBesideBubble();
  panelWindow.show();
}

function startMeetingWatcher() {
  if (meetingWatcher) {
    log.info('meeting watcher already running');
    return;
  }

  const check = async () => {
    if (meetingWatchInFlight) {
      log.warn('skipping meeting check because previous check is still running');
      return;
    }

    meetingWatchInFlight = true;
    try {
      const match = await detectActiveMeeting();
      setMeetingActive(Boolean(match), match);
    } catch (err) {
      log.error('meeting watch check failed:', err);
    } finally {
      meetingWatchInFlight = false;
    }
  };

  log.info('starting meeting watcher');
  check();
  STARTUP_MEETING_CHECK_DELAYS_MS.forEach((delay) => {
    setTimeout(check, delay);
  });
  meetingWatcher = setInterval(check, MEETING_CHECK_INTERVAL_MS);
}

ipcMain.handle('get-audio-sources', async () => {
  try {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      fetchWindowIcons: false,
      thumbnailSize: { width: 0, height: 0 },
    });
    return sources.map((s) => ({
      id: s.id,
      name: `${s.name} speaker output`,
      type: 'screen',
    }));
  } catch (err) {
    log.error('get-audio-sources error:', err);
    return [];
  }
});

ipcMain.handle('save-audio-file', async (_, arrayBuffer, fileName) => {
  try {
    const buffer = Buffer.from(arrayBuffer);
    const savePath = path.join(__dirname, path.basename(fileName));
    await fs.promises.writeFile(savePath, buffer);
    return savePath;
  } catch (err) {
    log.error('save-audio-file error:', err);
    return null;
  }
});

function checkBlackHole() {
  exec('system_profiler SPAudioDataType 2>/dev/null', (err, stdout, stderr) => {
    if (err) {
      log.warn('BlackHole check failed:', err.message || err);
      if (stderr) log.warn('BlackHole check stderr:', stderr.trim());
      return;
    }

    if (stdout && !stdout.toLowerCase().includes('blackhole')) {
      panelWindow?.webContents.send('mac-needs-blackhole');
    }
  });
}

ipcMain.handle('install-blackhole', async () => {
  try {
    await shell.openExternal('https://existential.audio/blackhole/');
    return { opened: true };
  } catch (err) {
    log.error('failed to open BlackHole download page:', err);
    return { opened: false, error: err.message || String(err) };
  }
});

ipcMain.handle('recheck-blackhole', () => new Promise((resolve) => {
  exec('system_profiler SPAudioDataType 2>/dev/null', (err, stdout, stderr) => {
    if (err) {
      log.warn('BlackHole recheck failed:', err.message || err);
      if (stderr) log.warn('BlackHole recheck stderr:', stderr.trim());
    }
    resolve({ installed: !!(stdout && stdout.toLowerCase().includes('blackhole')) });
  });
}));

ipcMain.on('toggle-panel', togglePanel);
ipcMain.on('minimize-overlay', () => panelWindow?.hide());
ipcMain.on('hide-overlay', () => panelWindow?.hide());
ipcMain.on('close-overlay', quitApp);
ipcMain.on('set-always-on-top', (_, val) => panelWindow?.setAlwaysOnTop(Boolean(val), 'screen-saver'));

ipcMain.on('drag-window', (_, { deltaX = 0, deltaY = 0 } = {}) => {
  if (!panelWindow || panelWindow.isDestroyed()) return;
  const [x, y] = panelWindow.getPosition();
  panelWindow.setPosition(x + Number(deltaX || 0), y + Number(deltaY || 0));
});

ipcMain.on('drag-bubble', (_, { deltaX = 0, deltaY = 0 } = {}) => {
  if (!bubbleWindow || bubbleWindow.isDestroyed()) return;
  const [x, y] = bubbleWindow.getPosition();
  bubbleWindow.setPosition(x + Number(deltaX || 0), y + Number(deltaY || 0));
});

ipcMain.on('quit-app', quitApp);

ipcMain.on('hide-bubble', () => {
  userHiddenBubble = true;
  manualUiVisible = false;
  bubbleWindow?.hide();
  panelWindow?.hide();
});

if (gotLock) {
  app.whenReady().then(() => {
    if (process.platform === 'win32') {
      app.setAppUserModelId('com.holovox.assist');
    }
    if (process.platform === 'darwin' && app.dock) {
      app.dock.hide();
    }

    configureAutoLaunch();
    createBubble();
    createPanel();
    startMeetingWatcher();

    if (pendingManualUi || !launchedInBackground) {
      pendingManualUi = false;
      showManualUi('foreground launch');
    }
  }).catch((err) => {
    log.error('app initialization failed:', err);
  });
}

app.on('window-all-closed', (e) => {
  if (!forceQuit) e.preventDefault();
});

app.on('before-quit', () => {
  forceQuit = true;
  stopMeetingWatcher();
});
