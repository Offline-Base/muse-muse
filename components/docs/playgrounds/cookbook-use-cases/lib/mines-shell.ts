import type { MinesState } from "@/components/docs/playgrounds/cookbook-use-cases/lib/cu-sim";

/**
 * The shell behind cua_run_command on the simulated Mines desktop (cookbook/computer-use). Nothing runs: each command
 * gets the answer the recipe's Ubuntu sandbox would give, and launching gnome-mines opens the game window. Muse Spark
 * sends compound probes ("pwd; whoami; ls", "ps aux | grep -i mine; ls ~/"), so a line is split the way bash splits
 * it (;, &&, ||, a trailing &, pipes, quotes kept), each command is answered on its own, and a pipeline's grep, head,
 * tail and wc -l filter what came before. Errors go to stderr, so a pipe doesn't filter them and 2>/dev/null hides
 * them, as in bash. cat on the Mines .desktop file prints the file.
 */

/** What one command did: the new state, what it wrote to stdout and to stderr, and its exit status. */
type Out = { state: MinesState; out: string; err: string; status: number };

const HOME = "/home/cua";
const DESKTOP_FILE = "/usr/share/applications/org.gnome.Mines.desktop";

const MINES_DESKTOP = [
  "[Desktop Entry]",
  "Name=Mines",
  "Comment=Clear hidden mines from a minefield",
  "Keywords=minesweeper;",
  "Exec=gnome-mines",
  "Icon=org.gnome.Mines",
  "Terminal=false",
  "Type=Application",
  "Categories=GNOME;GTK;Game;LogicGame;",
  "StartupNotify=true",
].join("\n");

const APPLICATIONS = ["org.gnome.Mines.desktop", "thunar.desktop", "xfce4-terminal.desktop", "mousepad.desktop", "xfce4-settings-manager.desktop"];
const HOME_DIRS = ["Desktop", "Documents", "Downloads"];
const DESKTOP_ITEMS = ["Files.desktop", "Mines.desktop", "Terminal.desktop", "Text Editor.desktop"];
const FOUND = ["/usr/games/gnome-mines", DESKTOP_FILE, "/usr/share/icons/hicolor/scalable/apps/org.gnome.Mines.svg"];
/** What which finds on this desktop. */
const ON_PATH: Record<string, string> = {
  "gnome-mines": "/usr/games/gnome-mines",
  ...Object.fromEntries(["bash", "cat", "find", "grep", "gtk-launch", "ls", "pgrep", "ps", "python3", "wmctrl", "xdg-open", "xdotool"].map((b) => [b, `/usr/bin/${b}`])),
};

const PS_HEADER = "USER         PID %CPU %MEM    VSZ   RSS TTY      STAT START   TIME COMMAND";
const PS_BASE = [
  "cua            1  0.0  0.1   4364  3200 ?        Ss   10:20   0:00 /bin/sh /usr/local/bin/start-desktop.sh",
  "cua           38  0.4  1.2 214820 48212 ?        Sl   10:20   0:02 Xvfb :0 -screen 0 1280x800x24",
  "cua           52  0.1  0.9 318004 36120 ?        Sl   10:20   0:00 xfce4-session",
  "cua           61  0.0  0.7 290112 28400 ?        Sl   10:20   0:00 xfce4-panel",
  "cua           64  0.0  0.8 305660 31876 ?        Sl   10:20   0:00 xfdesktop",
  "cua           90  0.2  1.4 112340 56720 ?        Sl   10:20   0:01 python -m computer_server --port 8000",
];
const PS_MINES = "cua         4242  0.3  1.1 512340 46120 ?        Sl   10:24   0:01 /usr/games/gnome-mines";

export interface Pipeline {
  /** What came before it: ";" (always runs), "&&" (after a success) or "||" (after a failure). */
  after: ";" | "&&" | "||";
  /** Its commands, piped left to right. */
  commands: string[];
}

/**
 * Splits a shell line the way bash does for this purpose: into pipelines on ;, &&, || and newlines (and after a lone
 * &, which stays on its command as " &" so it runs in the background), each into its commands on |, with quotes kept.
 */
export function shellPipelines(line: string): Pipeline[] {
  const out: Pipeline[] = [];
  let pipe: string[] = [];
  let cur = "";
  let quote: string | null = null;
  let after: Pipeline["after"] = ";";
  const endCommand = () => {
    if (cur.trim()) pipe.push(cur.trim());
    cur = "";
  };
  const endPipeline = (next: Pipeline["after"]) => {
    endCommand();
    if (pipe.length) out.push({ after, commands: pipe });
    pipe = [];
    after = next;
  };
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      cur += ch;
    } else if (ch === ";" || ch === "\n") endPipeline(";");
    else if ((ch === "&" || ch === "|") && line[i + 1] === ch) {
      endPipeline(ch === "&" ? "&&" : "||");
      i++;
    } else if (ch === "|") endCommand();
    else if (ch === "&" && line[i - 1] !== ">" && line[i + 1] !== ">") {
      cur = `${cur.trimEnd()} &`;
      endPipeline(";");
    } else cur += ch;
  }
  endPipeline(";");
  return out;
}

/** Shell words with their quotes removed. */
function words(cmd: string): string[] {
  const out: string[] = [];
  const re = /'([^']*)'|"((?:\\.|[^"\\])*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cmd))) out.push(m[1] ?? (m[2] !== undefined ? m[2].replace(/\\(.)/g, "$1") : m[3]));
  return out;
}

interface Cleaned {
  cmd: string;
  background: boolean;
  /** Where the redirections send output: dropped (> /dev/null, 2>/dev/null, &>/dev/null) or stderr into stdout (2>&1). */
  dropOut: boolean;
  dropErr: boolean;
  mergeErr: boolean;
}

/** Reads the redirections, then drops what doesn't change the answer: a trailing &, env assignments, sudo, nohup. */
function clean(cmd: string): Cleaned {
  let c = cmd.trim();
  const background = /\s&$/.test(c) || c === "&";
  c = c.replace(/\s*&$/, "");
  let dropOut = false;
  let dropErr = false;
  let mergeErr = false;
  c = c.replace(/\s*(&>>?|\d?>>?)\s*(&\d|[^\s;&|]+)/g, (_m, op: string, to: string) => {
    const fd = op.startsWith("&") ? "both" : op.startsWith("2") ? "err" : "out";
    if (fd === "err" && to === "&1") mergeErr = true;
    else if (fd === "both") (dropOut = true), (dropErr = true);
    else if (fd === "err") dropErr = true;
    else dropOut = true;
    return "";
  });
  for (let prev = ""; prev !== c; ) {
    prev = c;
    c = c.replace(/^(?:\w+=\S*\s+|sudo\s+(?:-\S+\s+)*|nohup\s+|setsid\s+(?:-f\s+)?|env\s+|exec\s+|timeout\s+\d+\S*\s+|dbus-launch\s+)/, "").trim();
  }
  return { cmd: c, background, dropOut, dropErr, mergeErr };
}

function expandHome(p: string): string {
  return p.replace(/^~(?=\/|$)/, HOME).replace(/^\$HOME(?=\/|$)/, HOME);
}

function listDir(path: string): string | null {
  const p = expandHome(path).replace(/\/+$/, "") || "/";
  if (p === HOME) return HOME_DIRS.join("  ");
  if (p === `${HOME}/Desktop`) return DESKTOP_ITEMS.join("\n");
  if (p === `${HOME}/Documents` || p === `${HOME}/Downloads`) return "";
  if (p === "/usr/games") return "gnome-mines\nsol";
  if (p === "/usr/share/applications") return APPLICATIONS.join("\n");
  if (p === "/") return "bin  boot  dev  etc  home  lib  media  mnt  opt  proc  root  run  sbin  srv  sys  tmp  usr  var";
  if (p === "/usr") return "bin  games  include  lib  local  sbin  share  src";
  if (p === "/usr/bin" || p === "/usr/local/bin") return p === "/usr/local/bin" ? "start-desktop.sh" : "bash  cat  find  grep  ls  ps  python3  xdotool  xdg-open";
  return null;
}

function readFile(path: string): string | null {
  const p = expandHome(path);
  if (p === DESKTOP_FILE || p === `${HOME}/Desktop/Mines.desktop`) return MINES_DESKTOP;
  return null;
}

/** grep, head, tail and wc -l over earlier output; anything else passes it through. */
function filter(text: string, cmd: string): string {
  const w = words(cmd);
  const name = w[0];
  const lines = text ? text.split("\n") : [];
  if (name === "grep" || name === "egrep") {
    const flags = w.slice(1).filter((x) => x.startsWith("-")).join("");
    const pattern = w.slice(1).find((x) => !x.startsWith("-")) ?? "";
    let re: RegExp;
    try {
      re = new RegExp(pattern, /i/.test(flags) ? "i" : "");
    } catch {
      re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), /i/.test(flags) ? "i" : "");
    }
    const invert = /v/.test(flags);
    const kept = lines.filter((l) => re.test(l) !== invert);
    return /c/.test(flags) ? String(kept.length) : kept.join("\n");
  }
  if (name === "head" || name === "tail") {
    const n = Number(w.find((x, i) => i > 0 && /^-?\d+$/.test(x))?.replace("-", "") ?? (w.includes("-n") ? w[w.indexOf("-n") + 1] : 10)) || 10;
    return (name === "head" ? lines.slice(0, n) : lines.slice(-n)).join("\n");
  }
  if (name === "wc" && w.includes("-l")) return String(lines.length);
  return text;
}

function processList(s: MinesState, grepLine?: string): string[] {
  return [...PS_BASE, ...(s.open ? [PS_MINES] : []), ...(grepLine ? [`cua         4310  0.0  0.0   6480  2300 pts/0    S+   10:25   0:00 ${grepLine}`] : [])];
}

const opens = (target: string) => /(^|\/)gnome-mines$|org\.gnome\.mines(\.desktop)?$|(^|\/)mines\.desktop$/i.test(target);

/** One command, without pipes. `grepNext` is the grep a pipeline runs after it, which ps lists as a process. */
function runOne(s: MinesState, raw: string, grepNext?: string): Out {
  const cleaned = clean(raw);
  const r = answer(s, cleaned, grepNext);
  const { dropOut, dropErr, mergeErr } = cleaned;
  const out = [dropOut ? "" : r.out, mergeErr && !dropOut ? r.err : ""].filter(Boolean).join("\n");
  return { ...r, out, err: dropErr || mergeErr ? "" : r.err };
}

function answer(s: MinesState, { cmd, background }: Cleaned, grepNext?: string): Out {
  const w = words(cmd);
  const name = (w[0] ?? "").split("/").pop() ?? "";
  const args = w.slice(1);
  const ok = (out: string, state = s, err = ""): Out => ({ state, out, err, status: 0 });
  const fail = (err: string, status = 1, out = ""): Out => ({ state: s, out, err, status });
  if (!name) return ok("");

  switch (name) {
    case "which": {
      const asked = args.filter((a) => !a.startsWith("-"));
      const out = asked.map((a) => ON_PATH[a] ?? "").filter(Boolean).join("\n");
      return asked.every((a) => ON_PATH[a]) ? ok(out) : fail("", 1, out);
    }
    case "whereis":
      return ok(args.map((a) => (a === "gnome-mines" ? "gnome-mines: /usr/games/gnome-mines /usr/share/man/man6/gnome-mines.6.gz" : `${a}:${ON_PATH[a] ? ` ${ON_PATH[a]}` : ""}`)).join("\n"));
    case "command":
    case "type": {
      const asked = args.filter((a) => !a.startsWith("-"));
      const found = asked.filter((a) => ON_PATH[a]);
      const out = found.map((a) => (name === "type" ? `${a} is ${ON_PATH[a]}` : ON_PATH[a])).join("\n");
      const missing = asked.filter((a) => !ON_PATH[a]).map((a) => `bash: type: ${a}: not found`).join("\n");
      return found.length === asked.length ? ok(out) : fail(name === "type" ? missing : "", 1, out);
    }
    case "ls": {
      const paths = args.filter((a) => !a.startsWith("-"));
      const listed: string[] = [];
      const missing: string[] = [];
      for (const p of paths.length ? paths : ["."]) {
        const dir = listDir(p === "." ? HOME : p);
        if (dir === null) missing.push(`ls: cannot access '${p}': No such file or directory`);
        else listed.push(paths.length > 1 ? `${p}:\n${dir}` : dir);
      }
      return missing.length ? fail(missing.join("\n"), 2, listed.join("\n\n")) : ok(listed.join("\n\n"));
    }
    case "cat": {
      const files = args.filter((a) => !a.startsWith("-"));
      const shown = files.map(readFile);
      const missing = files.filter((_f, i) => shown[i] === null).map((f) => `cat: ${f}: No such file or directory`);
      const out = shown.filter((t): t is string => t !== null).join("\n");
      return missing.length ? fail(missing.join("\n"), 1, out) : ok(out);
    }
    case "find":
    case "locate": {
      const target = args.find((a) => /mine/i.test(a));
      return ok(target ? FOUND.join("\n") : "");
    }
    case "grep":
    case "egrep": {
      // A grep with files of its own, such as grep -ril mine /usr/share/applications.
      const files = args.filter((a) => a.startsWith("/") || a.startsWith("~"));
      const pattern = args.find((a) => !a.startsWith("-") && !files.includes(a)) ?? "";
      const hit = files.some((f) => expandHome(f).startsWith("/usr/share/applications") || expandHome(f).startsWith(`${HOME}/Desktop`));
      if (!hit || !new RegExp(pattern.replace(/[^\w-]/g, "") || "^$", "i").test(MINES_DESKTOP)) return fail("");
      if (args.some((a) => /^-\w*l/.test(a))) return ok(DESKTOP_FILE);
      return ok(filter(MINES_DESKTOP, `grep ${args.filter((a) => a.startsWith("-")).join(" ")} '${pattern}'`).split("\n").map((l) => `${DESKTOP_FILE}:${l}`).join("\n"));
    }
    case "ps":
      return ok([PS_HEADER, ...processList(s, grepNext)].join("\n"));
    case "pgrep": {
      const pattern = args.find((a) => !a.startsWith("-")) ?? "";
      const match = s.open && /mine/i.test(pattern);
      if (!match) return fail("");
      return ok(args.some((a) => /^-\w*[al]/.test(a)) ? "4242 /usr/games/gnome-mines" : "4242");
    }
    case "pkill":
    case "killall":
    case "kill":
      return s.open && (args.some((a) => /mine/i.test(a)) || args.includes("4242")) ? ok("", { ...s, open: false }) : fail("");
    case "dpkg":
      return ok(args.includes("-L") ? FOUND.join("\n") : "ii  gnome-mines    1:40.1-1     amd64        minesweeper game for GNOME");
    case "apt":
    case "apt-cache":
      return ok(args.includes("list") ? "gnome-mines/noble,now 1:40.1-1 amd64 [installed]" : "gnome-mines - minesweeper game for GNOME");
    case "gnome-mines":
    case "gtk-launch":
    case "xdg-open":
    case "exo-open":
    case "gio":
    case "dex": {
      const target = name === "gnome-mines" ? "gnome-mines" : args.filter((a) => !a.startsWith("-") && a !== "launch").pop() ?? "";
      if (!opens(target)) return fail(`${name}: nothing to open here for '${target}'`);
      const opened: MinesState = { ...s, open: true };
      if (s.open) return ok("");
      // In the foreground the game keeps the shell busy until the bridge stops waiting; with & it returns at once.
      return ok(background || name !== "gnome-mines" ? (background ? "[1] 4242" : "") : "(gnome-mines is running in the foreground; the window is open)", opened);
    }
    case "whoami":
      return ok("cua");
    case "pwd":
      return ok(HOME);
    case "hostname":
      return ok("game-demo");
    case "id":
      return ok("uid=1000(cua) gid=1000(cua) groups=1000(cua),27(sudo)");
    case "uname":
      return ok(args.includes("-a") ? "Linux game-demo 6.8.0-45-generic #45-Ubuntu SMP x86_64 GNU/Linux" : "Linux");
    case "echo":
      return ok(args.map((a) => (a === "$DISPLAY" ? ":0" : a === "$HOME" ? HOME : a === "$USER" ? "cua" : a)).join(" "));
    case "wmctrl":
      return ok(["0x01200004 -1 game-demo xfce4-panel", "0x01400003 -1 game-demo Desktop", ...(s.open ? ["0x03a00007  0 game-demo Mines"] : [])].join("\n"));
    case "xdotool":
      if (args[0] === "search") return s.open && args.some((a) => /mine/i.test(a)) ? ok("62914567") : fail("");
      if (args.includes("getwindowname")) return ok(s.open ? "Mines" : "Desktop");
      return ok("");
    case "cd":
    case "sleep":
    case "true":
    case "export":
    case "clear":
      return ok("");
    default:
      return fail(`bash: ${w[0]}: command not found (this simulated desktop answers a few discovery commands; nothing actually runs)`, 127);
  }
}

/** Runs a whole command line on the simulated desktop: the new state, and what the shell printed. */
export function minesShell(s: MinesState, command: string): [MinesState, string] {
  let state = s;
  const printed: string[] = [];
  let lastStatus = 0;
  for (const { after, commands } of shellPipelines(command.trim())) {
    if (after === "&&" && lastStatus !== 0) continue;
    if (after === "||" && lastStatus === 0) continue;
    const [first, ...filters] = commands;
    const grepNext = filters.find((f) => /^e?grep\b/.test(f));
    const r = runOne(state, first, grepNext);
    state = r.state;
    // Only stdout goes down the pipe; stderr reaches the terminal as it is.
    let out = r.out;
    for (const f of filters) out = filter(out, f);
    const endsInGrep = filters.length > 0 && /^e?grep\b/.test(filters[filters.length - 1]);
    lastStatus = endsInGrep ? (out ? 0 : 1) : r.status;
    if (r.err) printed.push(r.err);
    if (out) printed.push(out);
  }
  return [state, printed.join("\n")];
}
