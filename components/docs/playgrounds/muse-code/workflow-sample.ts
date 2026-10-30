import type { MiniChild } from "@/components/docs/playgrounds/muse-code/workflows";

/**
 * The live mini workflow's starting input: a small service with a few planted problems (an injectable query, a role
 * change anyone can call, an API that answers in two styles, no tests), and the page's own example split into three
 * children: API design, security boundaries and test coverage.
 */

export const SAMPLE_SERVICE = `import express from "express";
import { db } from "./db.js";

const app = express();
app.use(express.json());

// GET /users?id=42
app.get("/users", async (req, res) => {
  const rows = await db.query(\`SELECT * FROM users WHERE id = \${req.query.id}\`);
  res.json(rows[0]);
});

// POST /users/:id/role
app.post("/users/:id/role", async (req, res) => {
  await db.query("UPDATE users SET role = $1 WHERE id = $2", [req.body.role, req.params.id]);
  res.send("ok");
});

app.listen(3000);
`;

export const MINI_CHILDREN: readonly MiniChild[] = [
  { title: "API design", task: "Inspect the API design" },
  { title: "Security boundaries", task: "Inspect the security boundaries" },
  { title: "Test coverage", task: "Inspect the test coverage" },
];

export const MINI_SYNTHESIS = "Verify the findings, then return one prioritized report";
