// The desktop shell: one locked-down window on one product's origin.

const { app, BrowserWindow, dialog, ipcMain, Menu, Notification, session, shell } = require("electron");
const { join } = require("node:path");

const { ConfigError, loadConfig } = require("./config");
const { allowPermission, canOpenExternally, createBridge, decideNavigation } = require("./policy");
const { runSelftest, selftestDirFrom } = require("./selftest");

const selftestDir = selftestDirFrom(process.argv);

function currentPlatform() {
  if (process.platform === "darwin") return "mac";
  return process.platform === "win32" ? "windows" : "linux";
}

function openExternally(url) {
  if (!canOpenExternally(url)) return;
  shell.openExternal(url).catch(() => {});
}

/** Permissions go only to the product's own origin. */
function lockSession(productOrigin) {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((contents, permission, respond, details) => {
    respond(allowPermission(permission, details.requestingUrl ?? contents.getURL(), productOrigin));
  });
  ses.setPermissionCheckHandler((_contents, permission, requestingOrigin) =>
    allowPermission(permission, requestingOrigin, productOrigin),
  );
  ses.setDevicePermissionHandler(() => false);
  ses.on("will-download", (event) => event.preventDefault());
}

/** Every navigation stays on the product's origin. Anything else leaves for the system browser or goes nowhere. */
function lockContents(contents, productOrigin) {
  const guard = (event, url) => {
    const decision = decideNavigation(url, productOrigin);
    if (decision === "allow") return;
    event.preventDefault();
    if (decision === "external") openExternally(url);
  };
  contents.on("will-navigate", guard);
  contents.on("will-redirect", guard);
  contents.setWindowOpenHandler(({ url }) => {
    openExternally(url);
    return { action: "deny" };
  });
}

function buildMenu(name) {
  const isMac = process.platform === "darwin";
  return Menu.buildFromTemplate([
    ...(isMac
      ? [{ label: name, submenu: [{ role: "hide" }, { role: "hideOthers" }, { role: "unhide" }, { type: "separator" }, { role: "quit" }] }]
      : [{ label: "File", submenu: [{ role: "quit" }] }]),
    { role: "editMenu" },
    { label: "View", submenu: [{ role: "reload" }, { type: "separator" }, { role: "togglefullscreen" }] },
    { role: "windowMenu" },
  ]);
}

function createWindow(config, hello) {
  const bridgeSetup = encodeURIComponent(JSON.stringify({ ...hello, origin: config.origin }));
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 360,
    minHeight: 480,
    title: config.name,
    backgroundColor: "#ffffff",
    show: Boolean(selftestDir),
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webviewTag: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      devTools: false,
      additionalArguments: [`--muse-bridge=${bridgeSetup}`],
    },
  });
  win.once("ready-to-show", () => win.show());
  // The product's page title can change the window's title, but its name stays in the app menu.
  lockContents(win.webContents, config.origin);
  return win;
}

async function start() {
  let config;
  try {
    config = loadConfig({ isPackaged: app.isPackaged, resourcesPath: process.resourcesPath, appPath: app.getAppPath() });
  } catch (error) {
    const message = error instanceof ConfigError ? error.message : "The product settings couldn't be read.";
    if (selftestDir) {
      process.stderr.write(`${message}\n`);
    } else {
      dialog.showErrorBox("This app can't open", message);
    }
    app.exit(1);
    return;
  }

  app.setName(config.name);
  Menu.setApplicationMenu(buildMenu(config.name));
  lockSession(config.origin);

  const platform = currentPlatform();
  const hello = {
    version: 1,
    platform,
    capabilities: { haptics: false, share: false, camera: false, notifications: Notification.isSupported(), glasses: false, frames: false },
  };

  const bridge = createBridge({
    productOrigin: config.origin,
    hello,
    showNotification: ({ title, body }) => new Notification({ title, body }).show(),
  });
  ipcMain.handle("muse:call", (event, request) => {
    const frame = event.senderFrame;
    const reply = bridge({ isMainFrame: Boolean(frame) && frame === event.sender.mainFrame, url: frame?.url ?? "" }, request);
    // A caller from anywhere else learns nothing, not even that the bridge exists.
    return reply ?? { ok: false, error: { code: "failed", message: "Something went wrong." } };
  });

  const win = createWindow(config, hello);

  if (selftestDir) {
    const code = await runSelftest({ win, dir: selftestDir, config, shellVersion: config.shellVersion, platform });
    app.exit(code);
    return;
  }

  win.loadURL(config.url).catch(() => {
    // The window stays open on Chromium's own error page, and View > Reload tries again.
  });
  app.on("activate", () => win.show());
}

// One window per app. A second launch brings the first one forward.
if (!selftestDir && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const [win] = BrowserWindow.getAllWindows();
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });
  // No <webview> tags or extra windows, whatever a page tries.
  app.on("web-contents-created", (_event, contents) => {
    contents.on("will-attach-webview", (event) => event.preventDefault());
  });
  app.on("window-all-closed", () => app.quit());
  app.whenReady().then(start);
}
