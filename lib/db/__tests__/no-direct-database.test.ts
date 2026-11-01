/**
 * A preview still has production's DATABASE_URL, DATABASE_URL_UNPOOLED, POSTGRES_* and PG* variables from the Neon
 * integration, so it stays off production's database only while every opener asks lib/db/url.ts (README.md, Preview
 * database). This fails when code in app/, lib/, components/, scripts/ or a root config reads one of those variables
 * itself, or imports a driver that would: the Neon driver's Pool and Client (and pg, postgres, @vercel/postgres) fill
 * a missing address from PGHOST and the other PG* variables. Only neon(), the HTTP driver, is allowed, in the two
 * files that pass it the helper's URL. Tests are left out; they set these variables on purpose.
 *
 *   npx tsx --test lib/db/__tests__/no-direct-database.test.ts
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, it } from "node:test";

const ROOT = join(import.meta.dirname, "../../..");
const DIRS = ["app", "lib", "components", "scripts"];
const CODE = /\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/;

/** The variables that hold a database address, production's on a preview, or the preview's own. */
const DB_VAR = String.raw`(?:DATABASE_URL\w*|PREVIEW_DATABASE_URL|POSTGRES_\w+|PG[A-Z_]+)`;
const ENV_READ = new RegExp(String.raw`process\.env(?:\.|\[\s*["'\x60])(${DB_VAR})\b`, "g");
const ENV_DESTRUCTURE = new RegExp(String.raw`\{([^{}]*)\}\s*=\s*process\.env\b`, "g");
const HELPER_READ = new RegExp(String.raw`\b(?:required|optional|flag|number|dollars)\(\s*["'](${DB_VAR})["']`, "g");

/**
 * Files that may still read one of them, and why. Each must still read one (so the list can't go stale), and must not
 * open a database any other way.
 */
const MAY_READ: Record<string, string> = {
  "lib/db/url.ts": "the helper itself",
  "scripts/dev/decide-fixtures.ts": "accepts only DATABASE_URL=pglite:<folder> (localDbDir), and throws otherwise",
  "scripts/dev/native-fixtures.ts": "accepts only DATABASE_URL=pglite:<folder> (localDbDir), and throws otherwise",
  "scripts/dev/room-fixtures.ts": "accepts only DATABASE_URL=pglite:<folder> (localDbDir), and throws otherwise",
  "scripts/dev/ui-smoke.tsx": "unsets DATABASE_URL to render pages with no database, then puts it back",
};

/** Drivers that read PG* variables for a missing address, and the Drizzle adapters built on them. Never imported. */
const FORBIDDEN_DRIVERS = new Set([
  "pg",
  "postgres",
  "@vercel/postgres",
  "drizzle-orm/node-postgres",
  "drizzle-orm/postgres-js",
  "drizzle-orm/vercel-postgres",
  "drizzle-orm/neon-serverless",
]);
const NEON = "@neondatabase/serverless";
/** Where neon() is called, with the URL from lib/db/url.ts. */
const MAY_IMPORT_NEON = new Set(["lib/db/client.ts", "lib/db/migrate.ts"]);

function sources(): string[] {
  const files: string[] = [];
  for (const dir of DIRS) {
    for (const entry of readdirSync(join(ROOT, dir), { recursive: true, encoding: "utf8" })) {
      const rel = `${dir}/${entry.split(sep).join("/")}`;
      if (!CODE.test(rel) || rel.includes("/__tests__/") || /\.test\.[cm]?[jt]sx?$/.test(rel) || rel.includes("/node_modules/")) continue;
      files.push(rel);
    }
  }
  for (const entry of readdirSync(ROOT)) if (CODE.test(entry)) files.push(entry);
  return files.sort();
}

function dbVarReads(text: string): string[] {
  const found = [...text.matchAll(ENV_READ), ...text.matchAll(HELPER_READ)].map((m) => m[1]!);
  for (const m of text.matchAll(ENV_DESTRUCTURE)) {
    found.push(...(m[1]!.match(new RegExp(String.raw`\b${DB_VAR}\b`, "g")) ?? []));
  }
  return found;
}

/** Every module specifier a file imports, statically, dynamically or with require. */
function specifiers(text: string): string[] {
  return [...text.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)["']([^"']+)["']/gm)].map((m) => m[1]!);
}

/** The names a file takes from the Neon driver, or null when it takes it in a form this check can't read. */
function neonNames(text: string): string[] | null {
  const forms = [
    new RegExp(String.raw`import\s*\{([^{}]*)\}\s*from\s*["']${NEON}["']`, "g"),
    new RegExp(String.raw`\{([^{}]*)\}\s*=\s*await\s+import\(\s*["']${NEON}["']\s*\)`, "g"),
  ];
  const names: string[] = [];
  let seen = 0;
  for (const form of forms) {
    for (const m of text.matchAll(form)) {
      seen++;
      names.push(...m[1]!.split(",").map((n) => n.trim().split(/\s+as\s+|\s*:\s*/)[0]!.replace(/^type\s+/, "")).filter(Boolean));
    }
  }
  return seen === specifiers(text).filter((s) => s === NEON).length ? names : null;
}

describe("database access outside lib/db/url.ts", () => {
  const files = sources();

  it("finds the code it checks", () => {
    for (const file of ["lib/db/url.ts", "lib/db/client.ts", "lib/env.ts", "lib/queries.ts", "scripts/migrate.ts", "drizzle.config.ts"]) {
      assert.ok(files.includes(file), file);
    }
  });

  it("reads no database variable anywhere else", () => {
    const readers = files.filter((file) => dbVarReads(readFileSync(join(ROOT, file), "utf8")).length > 0);
    assert.deepEqual(
      readers.filter((file) => !(file in MAY_READ)),
      [],
      "read the database through lib/db/url.ts (databaseUrl, databaseChoice) or env.databaseUrl instead",
    );
    for (const file of Object.keys(MAY_READ)) {
      if (file === "lib/db/url.ts") continue;
      assert.ok(readers.includes(file), `${file} no longer reads one: take it off MAY_READ`);
    }
  });

  it("imports no driver that fills an address from PG* variables, and neon() only where the helper's URL goes in", () => {
    const bad: string[] = [];
    for (const file of files) {
      const text = readFileSync(join(ROOT, file), "utf8");
      for (const spec of specifiers(text)) {
        if (FORBIDDEN_DRIVERS.has(spec)) bad.push(`${file}: ${spec}`);
      }
      if (!specifiers(text).includes(NEON)) continue;
      if (!MAY_IMPORT_NEON.has(file)) {
        bad.push(`${file}: ${NEON}`);
        continue;
      }
      const names = neonNames(text);
      if (names === null) bad.push(`${file}: ${NEON} in a form this check can't read`);
      else for (const name of names) if (name !== "neon") bad.push(`${file}: ${name} from ${NEON}`);
    }
    assert.deepEqual(bad, []);
  });

  it("would catch the reads and imports it is for", () => {
    assert.deepEqual(dbVarReads('const u = process.env.DATABASE_URL; const h = process.env["PGHOST"];'), ["DATABASE_URL", "PGHOST"]);
    assert.deepEqual(dbVarReads("const { POSTGRES_URL, OTHER } = process.env;"), ["POSTGRES_URL"]);
    assert.deepEqual(dbVarReads('return required("DATABASE_URL");'), ["DATABASE_URL"]);
    assert.deepEqual(dbVarReads("const s = process.env.SESSION_SECRET; // DATABASE_URL in a comment"), []);
    assert.deepEqual(neonNames('import { neon, Pool } from "@neondatabase/serverless";'), ["neon", "Pool"]);
    assert.deepEqual(neonNames('const { neon } = await import("@neondatabase/serverless");'), ["neon"]);
    assert.equal(neonNames('import * as n from "@neondatabase/serverless";'), null);
    assert.deepEqual(specifiers('import pg from "pg";\nconst x = require("postgres");'), ["pg", "postgres"]);
  });
});
