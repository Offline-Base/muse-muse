// Reads the one product this app opens, from resources/muse-product.json outside the asar. The packager rewrites that
// file for each product, so it's checked like any other input. With no Electron in it, this file tests alone.

const { createHash } = require("node:crypto");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const CONFIG_FILE = "muse-product.json";
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const MAX_CONFIG_BYTES = 16 * 1024;
const MAX_NAME_CHARS = 80;

class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConfigError";
  }
}

/** https anywhere, or http on the machine itself for a local run. No credentials in the URL. */
function isOpenableUrl(value) {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    if (url.username || url.password) return false;
    return url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname));
  } catch {
    return false;
  }
}

/** Checks a parsed config and returns only the known fields. Throws a ConfigError saying what's wrong. */
function parseConfig(raw) {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new ConfigError("The product settings aren't valid.");
  if (typeof raw.name !== "string" || !raw.name.trim() || raw.name.length > MAX_NAME_CHARS) {
    throw new ConfigError("The product needs a name of 80 characters or fewer.");
  }
  if (!isOpenableUrl(raw.url)) throw new ConfigError("The product's link must start with https.");
  const url = new URL(raw.url);
  return {
    name: raw.name.trim(),
    url: url.href,
    origin: url.origin,
    shellVersion: typeof raw.shellVersion === "string" ? raw.shellVersion.slice(0, 40) : "0.0.0",
  };
}

/** Where the settings live: next to the app when packaged, and in resources/ when run from source. */
function configPath({ isPackaged, resourcesPath, appPath }) {
  return isPackaged ? join(resourcesPath, CONFIG_FILE) : join(appPath, "resources", CONFIG_FILE);
}

function loadConfig(paths, read = readFileSync) {
  const path = configPath(paths);
  let text;
  try {
    text = read(path, "utf8");
  } catch {
    throw new ConfigError("The product settings are missing.");
  }
  if (text.length > MAX_CONFIG_BYTES) throw new ConfigError("The product settings are too large.");
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ConfigError("The product settings aren't valid.");
  }
  return parseConfig(parsed);
}

/**
 * Each product keeps its own folder under the app data folder. Every packaged app carries the same productName, so
 * without this they'd share one profile and one single-instance lock, and a second product would quit on launch.
 */
function profileFolderFor(origin) {
  return createHash("sha256").update(origin).digest("hex").slice(0, 16);
}

module.exports = { CONFIG_FILE, ConfigError, configPath, isOpenableUrl, loadConfig, parseConfig, profileFolderFor };
