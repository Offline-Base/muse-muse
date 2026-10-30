/**
 * The sample projects the agent demos work on, small enough to run in the page (sandbox.ts runs their tests):
 *
 * - agent-loop-target: the basic-agent-loop recipe's planted bugs, ported to JavaScript (the recipe ships Python and
 *   a Go mirror): an off-by-one, a wrong comparison, a missing edge case and an async race. It starts green except for
 *   the planted bugs, each with failing tests that define "done".
 * - callback-target: a small layered app in error-first callback style, for the interleaved-reasoning recipe's
 *   migrations to async/await. Its route tests check behavior only, so they pass before and after a migration done in
 *   the right order, and fail when a caller is left behind.
 */

export type ProjectFiles = Record<string, string>;

export interface AgentTask {
  id: string;
  label: string;
  /** The prompt, in the recipe's words. */
  prompt: string;
  /** The test file that defines "done" (run_tests runs every test file without one). */
  test?: string;
  /** Files that must have no callback-style code left when a migration is done. */
  migrate?: string[];
  /**
   * Test files the oracle runs in place of the project's own, for a task that changes an API on purpose: the agent
   * rewrites these tests itself (the task asks it to), so the oracle checks the new API with its own copy instead of
   * trusting the agent's.
   */
  oracleTests?: ProjectFiles;
}

export interface SampleProject {
  id: string;
  title: string;
  files: ProjectFiles;
  tasks: AgentTask[];
}

const PAGINATION = `/**
 * Split items into pages of pageSize items each. The last page may be shorter.
 */
function paginate(items, pageSize) {
  if (pageSize <= 0) {
    throw new Error("pageSize must be positive");
  }
  const pages = [];
  const numPages = Math.floor(items.length / pageSize);
  for (let p = 0; p < numPages; p++) {
    pages.push(items.slice(p * pageSize, (p + 1) * pageSize));
  }
  return pages;
}

module.exports = { paginate };
`;

const PAGINATION_TEST = `const assert = require("assert");
const { paginate } = require("../src/pagination");

test("splits evenly", () => {
  assert.deepStrictEqual(paginate([1, 2, 3, 4], 2), [[1, 2], [3, 4]]);
});

test("keeps the final partial page", () => {
  assert.deepStrictEqual(paginate([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
});

test("a page bigger than the list is one page", () => {
  assert.deepStrictEqual(paginate([1, 2], 5), [[1, 2]]);
});

test("an empty list has no pages", () => {
  assert.deepStrictEqual(paginate([], 3), []);
});

test("rejects a page size of zero", () => {
  assert.throws(() => paginate([1], 0));
});
`;

const GRADES = `/**
 * Letter grade for a 0 to 100 score: 90 and up is an A, 80 and up a B, 70 and up a C, 60 and up a D, below 60 an F.
 */
function letterGrade(score) {
  if (score > 90) return "A";
  if (score > 80) return "B";
  if (score > 70) return "C";
  if (score > 60) return "D";
  return "F";
}

/** How many scores pass (60 or more). */
function countPassing(scores) {
  return scores.filter((s) => s >= 60).length;
}

module.exports = { letterGrade, countPassing };
`;

const GRADES_TEST = `const assert = require("assert");
const { letterGrade, countPassing } = require("../src/grades");

test("95 is an A", () => {
  assert.strictEqual(letterGrade(95), "A");
});

test("exactly 90 is an A", () => {
  assert.strictEqual(letterGrade(90), "A");
});

test("exactly 80 is a B", () => {
  assert.strictEqual(letterGrade(80), "B");
});

test("59 is an F", () => {
  assert.strictEqual(letterGrade(59), "F");
});

test("counts passing scores", () => {
  assert.strictEqual(countPassing([59, 60, 75]), 2);
});
`;

const NORMALIZE = `/**
 * Scale numbers so the largest becomes 1. An empty list stays empty, and a list of zeros stays zeros.
 */
function normalize(values) {
  const max = Math.max(...values);
  return values.map((v) => v / max);
}

module.exports = { normalize };
`;

const NORMALIZE_TEST = `const assert = require("assert");
const { normalize } = require("../src/normalize");

test("scales to the largest value", () => {
  assert.deepStrictEqual(normalize([2, 4]), [0.5, 1]);
});

test("an empty list stays empty", () => {
  assert.deepStrictEqual(normalize([]), []);
});

test("a list of zeros stays zeros", () => {
  assert.deepStrictEqual(normalize([0, 0, 0]), [0, 0, 0]);
});
`;

const COUNTER = `const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A counter that several tasks increment at the same time. */
class Counter {
  constructor() {
    this.value = 0;
  }

  async increment() {
    const current = this.value;
    // Stands in for a slow read-modify-write, such as a database round trip.
    await sleep(1);
    this.value = current + 1;
  }
}

module.exports = { Counter };
`;

const COUNTER_TEST = `const assert = require("assert");
const { Counter } = require("../src/async_counter");

test("sequential increments all count", async () => {
  const counter = new Counter();
  await counter.increment();
  await counter.increment();
  await counter.increment();
  assert.strictEqual(counter.value, 3);
});

test("50 concurrent increments all count", async () => {
  const counter = new Counter();
  await Promise.all(Array.from({ length: 50 }, () => counter.increment()));
  assert.strictEqual(counter.value, 50);
});
`;

function loopTask(id: string, label: string, test: string, what: string): AgentTask {
  return {
    id,
    label,
    test,
    prompt: `${test} is failing. Read it and the implementation, fix the ${what} so the test passes, then run: run_tests ${test}`,
  };
}

export const AGENT_LOOP_TARGET: SampleProject = {
  id: "agent-loop-target",
  title: "agent-loop-target (JavaScript port)",
  files: {
    "src/pagination.js": PAGINATION,
    "src/grades.js": GRADES,
    "src/normalize.js": NORMALIZE,
    "src/async_counter.js": COUNTER,
    "tests/test_pagination.js": PAGINATION_TEST,
    "tests/test_grades.js": GRADES_TEST,
    "tests/test_normalize.js": NORMALIZE_TEST,
    "tests/test_async_counter.js": COUNTER_TEST,
  },
  tasks: [
    loopTask("pagination", "Fix the off-by-one", "tests/test_pagination.js", "bug"),
    loopTask("grades", "Fix the comparison", "tests/test_grades.js", "bug"),
    loopTask("normalize", "Fix the edge case", "tests/test_normalize.js", "bug"),
    loopTask("async_counter", "Fix the async race", "tests/test_async_counter.js", "race condition"),
  ],
};

// ---------------------------------------------------------------------------------------------------------------

const STORE = `// An in-memory store with an error-first callback API: the style this project is moving off.
const users = {
  u1: { id: "u1", name: "Ada" },
  u2: { id: "u2", name: "Grace" },
};

const orders = [
  { id: "o1", userId: "u1", total: 25 },
  { id: "o2", userId: "u1", total: 40 },
  { id: "o3", userId: "u2", total: 15 },
];

function later(fn) {
  setTimeout(fn, 1);
}

function findUser(id, cb) {
  later(() => (users[id] ? cb(null, { ...users[id] }) : cb(new Error("No user " + id))));
}

function findOrdersByUser(userId, cb) {
  later(() => cb(null, orders.filter((o) => o.userId === userId).map((o) => ({ ...o }))));
}

module.exports = { findUser, findOrdersByUser };
`;

const CALLBACK_UTILS = `/**
 * Run an error-first operation, retrying when it fails, up to \`times\` attempts in all.
 * operation(cb) gets a callback; the final callback gets the last error, or the result.
 */
function retry(operation, times, cb) {
  let attempt = 0;
  function run() {
    attempt++;
    operation((err, result) => {
      if (err && attempt < times) return run();
      cb(err, result);
    });
  }
  run();
}

module.exports = { retry };
`;

/** The oracle's tests for retry once it's migrated: it takes an operation returning a Promise and returns a Promise. */
export const RETRY_ASYNC_TEST = `const assert = require("assert");
const { retry } = require("../src/lib/callbackUtils");

test("retry resolves with the first success", async () => {
  let calls = 0;
  const flaky = async () => {
    calls++;
    if (calls < 3) throw new Error("flaky");
    return "ok";
  };
  assert.strictEqual(await retry(flaky, 5), "ok");
  assert.strictEqual(calls, 3);
});

test("retry rejects with the last error after the last attempt", async () => {
  let calls = 0;
  let error = null;
  try {
    await retry(async () => {
      calls++;
      throw new Error("down");
    }, 2);
  } catch (err) {
    error = err;
  }
  assert.ok(error, "retry rejects once every attempt has failed");
  assert.strictEqual(error.message, "down");
  assert.strictEqual(calls, 2);
});
`;

const CALLBACK_UTILS_TEST = `const assert = require("assert");
const { retry } = require("../src/lib/callbackUtils");

test("retry returns the first success", () =>
  new Promise((resolve, reject) => {
    let calls = 0;
    const flaky = (cb) => {
      calls++;
      if (calls < 3) cb(new Error("flaky"));
      else cb(null, "ok");
    };
    retry(flaky, 5, (err, value) => {
      try {
        assert.strictEqual(err, null);
        assert.strictEqual(value, "ok");
        assert.strictEqual(calls, 3);
        resolve();
      } catch (e) {
        reject(e);
      }
    });
  }));

test("retry gives up after the last attempt", () =>
  new Promise((resolve, reject) => {
    let calls = 0;
    retry((cb) => { calls++; cb(new Error("down")); }, 2, (err) => {
      try {
        assert.strictEqual(err.message, "down");
        assert.strictEqual(calls, 2);
        resolve();
      } catch (e) {
        reject(e);
      }
    });
  }));
`;

const USER_REPO = `const store = require("../db/store");

function getUser(id, cb) {
  store.findUser(id, (err, user) => {
    if (err) return cb(err);
    cb(null, { id: user.id, name: user.name });
  });
}

module.exports = { getUser };
`;

const ORDER_REPO = `const store = require("../db/store");
const { getUser } = require("./userRepository");

function getOrdersForUser(userId, cb) {
  getUser(userId, (err, user) => {
    if (err) return cb(err);
    store.findOrdersByUser(user.id, (err2, orders) => {
      if (err2) return cb(err2);
      cb(null, { user, orders, total: orders.reduce((sum, o) => sum + o.total, 0) });
    });
  });
}

module.exports = { getOrdersForUser };
`;

const USERS_ROUTE = `const { getUser } = require("../repositories/userRepository");

// A route handler: (req) => Promise<{ status, body }>. The HTTP layer is already promise-based.
function getUserRoute(req) {
  return new Promise((resolve) => {
    getUser(req.params.id, (err, user) => {
      if (err) return resolve({ status: 404, body: { error: err.message } });
      resolve({ status: 200, body: user });
    });
  });
}

module.exports = { getUserRoute };
`;

const ORDERS_ROUTE = `const { getOrdersForUser } = require("../repositories/orderRepository");

function getOrdersRoute(req) {
  return new Promise((resolve) => {
    getOrdersForUser(req.params.id, (err, result) => {
      if (err) return resolve({ status: 404, body: { error: err.message } });
      resolve({ status: 200, body: result });
    });
  });
}

module.exports = { getOrdersRoute };
`;

const ROUTES_TEST = `const assert = require("assert");
const { getUserRoute } = require("../src/routes/users");
const { getOrdersRoute } = require("../src/routes/orders");

test("GET /users/u1", async () => {
  const res = await getUserRoute({ params: { id: "u1" } });
  assert.deepStrictEqual(res, { status: 200, body: { id: "u1", name: "Ada" } });
});

test("GET /users/nope is a 404", async () => {
  const res = await getUserRoute({ params: { id: "nope" } });
  assert.strictEqual(res.status, 404);
});

test("GET /users/u1/orders", async () => {
  const res = await getOrdersRoute({ params: { id: "u1" } });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.total, 65);
  assert.strictEqual(res.body.orders.length, 2);
});

test("orders for a missing user is a 404", async () => {
  const res = await getOrdersRoute({ params: { id: "nope" } });
  assert.strictEqual(res.status, 404);
});
`;

export const CALLBACK_TARGET: SampleProject = {
  id: "callback-target",
  title: "callback-target (a small callback-style app)",
  files: {
    "src/db/store.js": STORE,
    "src/lib/callbackUtils.js": CALLBACK_UTILS,
    "src/repositories/userRepository.js": USER_REPO,
    "src/repositories/orderRepository.js": ORDER_REPO,
    "src/routes/users.js": USERS_ROUTE,
    "src/routes/orders.js": ORDERS_ROUTE,
    "tests/callbackUtils.test.js": CALLBACK_UTILS_TEST,
    "tests/routes.test.js": ROUTES_TEST,
  },
  tasks: [
    {
      id: "retry",
      label: "1. Leaf function (retry)",
      prompt:
        "In src/lib/callbackUtils.js, migrate the retry function from error-first callbacks to async/await: it takes an operation returning a Promise and returns a Promise, retrying on rejection up to the given count. Update its tests in tests/callbackUtils.test.js, then run run_checks.",
      migrate: ["src/lib/callbackUtils.js"],
      oracleTests: { "tests/callbackUtils.test.js": RETRY_ASYNC_TEST },
    },
    {
      id: "user-repo",
      label: "2. One file and its callers",
      prompt:
        "Migrate src/repositories/userRepository.js to async/await: every function returns a Promise. Update its callers so the project still works, then run run_checks.",
      migrate: ["src/repositories/userRepository.js", "src/routes/users.js"],
    },
    {
      id: "order-repo",
      label: "3. Cross-file order",
      prompt:
        "Migrate src/repositories/orderRepository.js and the userRepository.getUser it depends on to async/await, in the correct dependency order, then update src/routes/orders.js. Keep tests/routes.test.js passing, then run run_checks.",
      migrate: [
        "src/repositories/userRepository.js",
        "src/repositories/orderRepository.js",
        "src/routes/users.js",
        "src/routes/orders.js",
      ],
    },
  ],
};

export const PROJECTS: Record<string, SampleProject> = {
  [AGENT_LOOP_TARGET.id]: AGENT_LOOP_TARGET,
  [CALLBACK_TARGET.id]: CALLBACK_TARGET,
};

const CALLBACK_PARAM = /^(cb|callback|done|next)$/;

/**
 * Where a file still uses error-first callbacks, for the migration check: a function defined with a callback as its
 * last parameter (cb, callback, done, next), or an error-first callback handed to the project's own code. Adapting
 * the callback-style store (a line that calls store.) is how an async function wraps it, so that isn't counted.
 */
export function callbackSpots(source: string): Array<{ line: number; text: string }> {
  const spots: Array<{ line: number; text: string }> = [];
  const definitions = [/\bfunction\b[^(]*\(([^)]*)\)/, /\b(?:const|let|var)\s+\w+\s*=\s*(?:async\s*)?\(([^)]*)\)\s*=>/];
  const errorFirst = /(\(\s*err\w*\s*(?:,[^)]*)?\)\s*=>)|(\bfunction\s*\w*\s*\(\s*err\w*\s*[,)])/;
  source.split("\n").forEach((text, i) => {
    const takesCallback = definitions.some((re) => {
      const params = re.exec(text)?.[1]?.split(",").map((p) => p.trim()) ?? [];
      return params.length > 0 && CALLBACK_PARAM.test(params[params.length - 1] ?? "");
    });
    const handsCallback = errorFirst.test(text) && !/\bstore\./.test(text);
    if (takesCallback || handsCallback) spots.push({ line: i + 1, text: text.trim() });
  });
  return spots;
}
