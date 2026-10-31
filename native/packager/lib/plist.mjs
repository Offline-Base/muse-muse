// Edits the XML property lists Electron and electron-builder write. They are flat enough that a parser would only add a
// dependency, and the tests read each result back with real plutil where it exists.

export function escapeXml(text) {
  return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function unescapeXml(text) {
  return text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

/** The value of a top-level string key, or null. */
export function getString(xml, key) {
  const found = new RegExp(`<key>${key}</key>\\s*<string>([\\s\\S]*?)</string>`).exec(xml);
  return found ? unescapeXml(found[1]) : null;
}

/** Sets a string key, adding it at the top level of the dict if it isn't there. */
export function setString(xml, key, value) {
  const entry = `<key>${key}</key>\n\t<string>${escapeXml(value)}</string>`;
  const pattern = new RegExp(`<key>${key}</key>\\s*<string>[\\s\\S]*?</string>`);
  // Functions as replacers, because a product's name can hold "$&".
  if (pattern.test(xml)) return xml.replace(pattern, () => entry);
  const at = xml.indexOf("<dict>");
  if (at < 0) throw new Error("This property list has no dict.");
  return `${xml.slice(0, at + 6)}\n\t${entry}${xml.slice(at + 6)}`;
}
