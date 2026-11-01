// A VS Code extension for one Muse Muse product, generated from its musemuse.json. Each of the product's actions is a
// command: it asks for the action's fields, sends them to the live product and opens the reply as JSON.
// No dependencies. Built with Muse Muse, a hackathon concept. Not an official Meta product.
"use strict";

const vscode = require("vscode");
const PRODUCT = require("./product.json");

const TIMEOUT_MS = 120000;
const MAX_FIELDS = 8;

/** The address the actions run at: the setting when it is a web address, else the live product. */
function baseUrl() {
  const set = String(vscode.workspace.getConfiguration(PRODUCT.configSection).get("baseUrl") || "").trim().replace(/\/+$/, "");
  return /^https:\/\/[^\s/]+/.test(set) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(set) ? set : PRODUCT.liveUrl.replace(/\/+$/, "");
}

/** The editor's selected text, for the first text field. */
function selection() {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.selection.isEmpty) return "";
  return editor.document.getText(editor.selection);
}

function words(name) {
  return String(name).replace(/[_-]+/g, " ").replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
}

/** Asks for one field. Resolves undefined when the person cancels, and null for an optional field left empty. */
async function askField(name, schema, required, prefill) {
  const label = `${words(name)}${required ? "" : " (optional)"}`;
  const about = typeof schema.description === "string" ? schema.description.slice(0, 200) : "";
  if (Array.isArray(schema.enum) && schema.enum.length) {
    const items = schema.enum.map((v) => ({ label: String(v), value: v }));
    if (!required) items.push({ label: "Leave it out", value: null });
    const picked = await vscode.window.showQuickPick(items, { title: label, placeHolder: about || undefined, ignoreFocusOut: true });
    return picked === undefined ? undefined : picked.value;
  }
  if (schema.type === "boolean") {
    const items = [{ label: "Yes", value: true }, { label: "No", value: false }];
    if (!required) items.push({ label: "Leave it out", value: null });
    const picked = await vscode.window.showQuickPick(items, { title: label, placeHolder: about || undefined, ignoreFocusOut: true });
    return picked === undefined ? undefined : picked.value;
  }
  const numeric = schema.type === "number" || schema.type === "integer";
  const text = schema.type === "string";
  const typed = await vscode.window.showInputBox({
    title: label,
    prompt: about || (text ? undefined : "As JSON"),
    value: prefill || (text || numeric ? "" : schema.type === "array" ? "[]" : ""),
    ignoreFocusOut: true,
    validateInput(value) {
      if (!value && !required) return null;
      if (!value) return "This one is needed.";
      if (numeric) return Number.isFinite(Number(value)) && (schema.type !== "integer" || Number.isInteger(Number(value))) ? null : "Type a number.";
      if (text) return null;
      try {
        JSON.parse(value);
        return null;
      } catch {
        return "Type it as JSON.";
      }
    },
  });
  if (typed === undefined) return undefined;
  if (!typed && !required) return null;
  if (numeric) return Number(typed);
  if (text) return typed;
  return JSON.parse(typed);
}

/** The action's input, asked field by field, or as one JSON object when its schema has no fields to ask for. */
async function collectInput(action) {
  const schema = action.input && typeof action.input === "object" ? action.input : {};
  const props = schema.properties && typeof schema.properties === "object" ? schema.properties : null;
  if (!props || !Object.keys(props).length || Object.keys(props).length > MAX_FIELDS) {
    const typed = await vscode.window.showInputBox({
      title: `${action.title}: the input, as JSON`,
      value: JSON.stringify(action.example || {}),
      ignoreFocusOut: true,
      validateInput(value) {
        try {
          const v = JSON.parse(value);
          return v && typeof v === "object" && !Array.isArray(v) ? null : "Type a JSON object.";
        } catch {
          return "Type it as JSON.";
        }
      },
    });
    return typed === undefined ? undefined : JSON.parse(typed);
  }
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  const names = Object.keys(props).sort((a, b) => Number(required.has(b)) - Number(required.has(a)));
  let prefill = selection();
  const input = {};
  for (const name of names) {
    const field = props[name] && typeof props[name] === "object" ? props[name] : {};
    const value = await askField(name, field, required.has(name), field.type === "string" ? prefill : "");
    if (value === undefined) return undefined;
    if (field.type === "string" && prefill) prefill = "";
    if (value !== null) input[name] = value;
  }
  return input;
}

async function run(action, out) {
  const input = await collectInput(action);
  if (input === undefined) return;
  const url = `${baseUrl()}/api/actions/${encodeURIComponent(action.name)}`;
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `${PRODUCT.name}: ${action.title}` }, async () => {
    let res;
    try {
      res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(input), redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (err) {
      out.appendLine(`${action.name}: ${url} couldn't be reached (${err && err.name ? err.name : "error"})`);
      vscode.window.showErrorMessage(`${PRODUCT.name} couldn't be reached. Check your connection, or the address in its settings.`);
      return;
    }
    const text = await res.text();
    let reply;
    try {
      reply = JSON.parse(text);
    } catch {
      out.appendLine(`${action.name}: HTTP ${res.status}, not JSON`);
      vscode.window.showErrorMessage(`${PRODUCT.name} answered with something that isn't JSON (HTTP ${res.status}).`);
      return;
    }
    if (!res.ok) {
      const said = reply && typeof reply.error === "string" ? reply.error.slice(0, 300) : `HTTP ${res.status}`;
      out.appendLine(`${action.name}: ${said}`);
      vscode.window.showErrorMessage(`${PRODUCT.name}: ${said}`);
      return;
    }
    const doc = await vscode.workspace.openTextDocument({ language: "json", content: `${JSON.stringify(reply, null, 2)}\n` });
    await vscode.window.showTextDocument(doc, { preview: true });
  });
}

function activate(context) {
  const out = vscode.window.createOutputChannel(PRODUCT.name);
  context.subscriptions.push(out);
  for (const action of PRODUCT.actions) {
    context.subscriptions.push(vscode.commands.registerCommand(action.command, () => run(action, out)));
  }
  context.subscriptions.push(vscode.commands.registerCommand(PRODUCT.openCommand, () => vscode.env.openExternal(vscode.Uri.parse(baseUrl()))));
}

function deactivate() {}

module.exports = { activate, deactivate, baseUrl, collectInput };
