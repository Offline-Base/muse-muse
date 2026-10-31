// The desktop shell: one locked-down window on one product's origin.

const { app, BrowserWindow, dialog, ipcMain, Menu, Notification, session, shell } = require("electron");
const { join } = require("node:path");

const { ConfigError, loadConfig, profileFolderFor } = require("./config");
const {
  allowDownload,
  canOpenExternally,
  createBridge,
  createPermissionGate,
  createRateLimiter,
  decideNavigation,
  decideRedirect,
  failurePage,
  permissionQuestion,
} = require("./policy");
const { runSelftest, selftestDirFrom } = require("./selftest");

const selftestDir = selftestDirFrom(process.argv);
const externalOpens = createRateLimiter();
const downloads = createRateLimiter();

/** The product this app opens, or the reason it can't say. Read first, because the profile folder depends on it. */
function readProduct() {
  try {
    return { config: loadConfig({ isPackaged: app.isPackaged, resourcesPath: process.resourcesPath, appPath: app.getAppPath() }) };
  } catch (error) {
    return { problem: error instanceof ConfigError ? error.message : "The product settings couldn't be read." };
  }
}

function currentPlatform() {
  if (process.platform === "darwin") return "mac";
  return process.platform === "win32" ? "windows" : "linux";
}

function openExternally(url) {
  if (!canOpenExternally(url) || !externalOpens()) return;
  shell.openExternal(url).catch(() => {});
}

/** Nobody is there to answer during a selftest, so the answer is no. */
async function askPerson(name, kinds) {
  if (selftestDir) return false;
  const [win] = BrowserWindow.getAllWindows();
  const options = {
    type: "question",
    message: permissionQuestion(name, kinds),
    detail: "It will ask again the next time you open it.",
    buttons: ["Allow", "Don't Allow"],
    defaultId: 1,
    cancelId: 1,
  };
  const { response } = await (win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options));
  return response === 0;
}

/** Permissions go only to the product's own origin, and the person says yes to camera, microphone and location. */
function lockSession(config) {
  const ses = session.defaultSession;
  const gate = createPermissionGate({ productOrigin: config.origin, ask: (kinds) => askPerson(config.name, kinds) });
  ses.setPermissionRequestHandler((contents, permission, respond, details) => {
    gate.request(permission, details.requestingUrl ?? contents.getURL(), details.mediaTypes).then(respond, () => respond(false));
  });
  ses.setPermissionCheckHandler((_contents, permission, requestingOrigin, details) =>
    gate.check(permission, requestingOrigin, details?.mediaType),
  );
  ses.setDevicePermissionHandler(() => false);
  ses.on("will-download", (event, item, contents) => {
    if (selftestDir || !allowDownload(contents?.getURL(), config.origin) || !downloads()) {
      event.preventDefault();
      return;
    }
    // Electron shows its save dialog after this, so the person picks where it goes.
    item.setSaveDialogOptions({ title: "Save file" });
  });
}

/** Every navigation stays on the product's origin. Anything else leaves for the system browser or goes nowhere. */
function lockContents(contents, productOrigin) {
  const act = (event, url, decision) => {
    if (decision === "allow") return;
    event.preventDefault();
    if (decision === "external") openExternally(url);
  };
  contents.on("will-navigate", (details) => act(details, details.url, decideNavigation(details.url, productOrigin)));
  contents.on("will-redirect", (details) =>
    act(details, details.url, decideRedirect(details.url, details.isMainFrame, productOrigin)),
  );
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

function refuseToStart(message) {
  if (selftestDir) {
    process.stderr.write(`${message}\n`);
  } else {
    dialog.showErrorBox("This app can't open", message);
  }
  app.exit(1);
}

async function start(config) {
  app.setName(config.name);
  Menu.setApplicationMenu(buildMenu(config.name));
  lockSession(config);

  const platform = currentPlatform();
  const notificationsSupported = Notification.isSupported();
  const hello = {
    version: 1,
    platform,
    capabilities: { haptics: false, share: false, camera: false, notifications: notificationsSupported, glasses: false, frames: false },
  };

  const bridge = createBridge({
    productOrigin: config.origin,
    hello,
    notificationsSupported,
    showNotification: ({ title, body }) => new Notification({ title, body }).show(),
  });
  app.on("will-quit", () => bridge.dispose());
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

  // Electron has no error page of its own, so a failed load would leave a blank window. -3 is a navigation this shell stopped.
  win.webContents.on("did-fail-load", (_event, code, _description, _url, isMainFrame) => {
    if (isMainFrame && code !== -3) win.loadURL(failurePage(config.url)).catch(() => {});
  });
  // The load's own failure shows up in did-fail-load above.
  win.loadURL(config.url).catch(() => {});
  app.on("activate", () => win.show());
}

const { config, problem } = readProduct();
// Before the lock, which belongs to this folder. Session storage follows it too, so products don't share any.
if (config) app.setPath("userData", join(app.getPath("appData"), "Muse Muse", profileFolderFor(config.origin)));

// One window per product. A second launch of the same product brings the first one forward.
if (config && !selftestDir && !app.requestSingleInstanceLock()) {
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
  app.whenReady().then(() => (config ? start(config) : refuseToStart(problem)));
}
