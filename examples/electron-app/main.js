// A minimal Electron main process that exposes a CDP endpoint so gifsmith can
// attach with the electron() adapter and record the real app window — no code
// changes to the app itself, just two launch switches. Tauri (WebView2) works
// the same way; see the gifsmith README › Adapters.
const { app, BrowserWindow } = require('electron');
const path = require('path');

// The one non-obvious bit: expose a remote-debugging port, and allow the CDP
// WebSocket origin (modern Chromium rejects the handshake without it).
app.commandLine.appendSwitch('remote-debugging-port', '9222');
app.commandLine.appendSwitch('remote-allow-origins', '*');
app.commandLine.appendSwitch('disable-background-timer-throttling');

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 1200,
    height: 760,
    frame: false, // borderless so the renderer fills the whole capture
    // Render without showing on screen so the capture is invisible; the web
    // contents still paints for the screencast.
    show: false,
    paintWhenInitiallyHidden: true,
    backgroundColor: '#0b0e17',
    webPreferences: { backgroundThrottling: false },
  });
  win.loadFile(path.join(__dirname, 'renderer.html'));

  // If you'd rather watch it, comment out show:false above, or:
  if (process.env.GIFSMITH_SHOW) win.showInactive();
});

// Keep the process alive during recording (the recorder kills it when done).
app.on('window-all-closed', () => {});
