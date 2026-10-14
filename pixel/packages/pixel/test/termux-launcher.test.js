const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { detect } = require("../dist/terminal/index.js");
const { launcherTerminal } = require("../dist/terminal/terminals/termux-launcher.js");

/** A launcher answering from routes like {"GET /v1/panes": (body) => [status, json]}, remembering what was asked. */
async function fakeLauncher(t, routes) {
  const requests = [];
  const server = http.createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => (raw += chunk));
    request.on("end", () => {
      const body = raw ? JSON.parse(raw) : null;
      requests.push({ method: request.method, url: request.url, authorization: request.headers.authorization, body });
      const route = routes[`${request.method} ${request.url}`];
      const [status, json] = route ? route(body) : [404, { ok: false, error: "not_found", message: "no route" }];
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(json));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tb-launcher-"));
  const dir = path.join(home, ".launcherctl");
  fs.mkdirSync(dir);
  const base = `http://127.0.0.1:${server.address().port}`;
  fs.writeFileSync(path.join(dir, "endpoint"), `${base}\n${base}/v1\n`);
  fs.writeFileSync(path.join(dir, "token"), "secret\n");
  return { home, dir, requests };
}

/** A /proc laid out from {pid: {ppid, env, tty}}. */
function fakeProc(processes) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tb-proc-"));
  for (const [pid, info] of Object.entries(processes)) {
    const dir = path.join(root, pid);
    fs.mkdirSync(path.join(dir, "fd"), { recursive: true });
    fs.writeFileSync(path.join(dir, "stat"), `${pid} (a (weird) name) S ${info.ppid ?? 1} ${pid} ${pid} 0 -1\n`);
    fs.writeFileSync(
      path.join(dir, "environ"),
      Object.entries(info.env ?? {}).map(([key, value]) => `${key}=${value}\0`).join(""),
    );
    fs.symlinkSync(info.tty ?? "/dev/null", path.join(dir, "fd", "0"));
  }
  return root;
}

// window 7 holds p1 (shell 100, the agent's) beside p3 (shell 102); window 8 holds p2 (shell 101)
function panes({ features = ["placement", "geometry", "windows"], columns = 120, rows = 60 } = {}) {
  return () => [200, {
    windows: [
      {
        index: 0, id: 7, current: true,
        panes: [
          { id: "p1", pid: 100, columns, rows, floating: false, geometry: { left: 0, top: 0, columns, rows } },
          { id: "p3", pid: 102, columns: 39, rows, floating: false, geometry: { left: columns + 1, top: 0, columns: 39, rows } },
        ],
      },
      { index: 1, id: 8, current: false, panes: [{ id: "p2", pid: 101, columns: 80, rows: 24, geometry: null }] },
    ],
    activePane: "p1",
    features,
  }];
}

const PROC = {
  100: { tty: "/dev/pts/1" },
  101: { tty: "/dev/pts/2" },
  102: { tty: "/dev/pts/3" },
  300: { ppid: 250 },
  250: { ppid: 1, env: { TERMUX_LAUNCHER_PANE: "p3" } },
};

const ok = () => [200, { ok: true }];
const refused = (status, error) => () => [status, { ok: false, error, message: "refused" }];

function terminalFor(launcher, extra = {}) {
  return launcherTerminal({ dir: launcher.dir, env: {}, procRoot: fakeProc(PROC), ...extra });
}

const splitRequest = (direction, size = null) => ({
  from: { id: "p1", tab: "7" },
  direction,
  command: ["terminal-browser", "open", "en.wikipedia.org"],
  size,
  tty: null,
});

test("termux-launcher is known by its pane variable or TERM_PROGRAM; a multiplexer inside it wins", () => {
  assert.equal(detect({ TERMUX_LAUNCHER_PANE: "p1" }, async () => "")?.name, "termux-launcher");
  assert.equal(detect({ TERM_PROGRAM: "termux-launcher" }, async () => "")?.name, "termux-launcher");
  assert.equal(detect({ TERMUX_LAUNCHER_PANE: "p1", HERDR_PANE_ID: "w:p" }, async () => "")?.name, "herdr");
  assert.equal(detect({ TERMUX_LAUNCHER_PANE: "p1", TMUX: "/tmp/tmux-1/default,1,0" }, async () => "")?.name, "tmux");
});

test("termux-launcher splits beside the pane it is asked from, with the token", async (t) => {
  const launcher = await fakeLauncher(t, { "GET /v1/panes": panes(), "POST /v1/panes": ok });
  await terminalFor(launcher).split(splitRequest("right", 1.4));
  const open = launcher.requests.at(-1);
  assert.equal(open.url, "/v1/panes");
  assert.equal(open.authorization, "Bearer secret");
  assert.equal(open.body.from, "p1");
  assert.equal(open.body.direction, "right");
  assert.equal(open.body.size, 0.9);
  assert.equal(open.body.focus, false);
  assert.equal(open.body.tag, "terminal-browser");
  assert.equal(open.body.cwd, process.cwd());
  assert.deepEqual(open.body.command.slice(0, 2), ["sh", "-c"]);
  assert.deepEqual(open.body.command.slice(3), ["terminal-browser", "terminal-browser", "open", "en.wikipedia.org"]);
});

test("termux-launcher leaves placement to the launcher when it cannot place panes", async (t) => {
  const launcher = await fakeLauncher(t, { "GET /v1/panes": panes({ features: [] }), "POST /v1/panes": ok });
  await terminalFor(launcher).split(splitRequest("right", 0.4));
  const open = launcher.requests.at(-1);
  assert.equal(open.url, "/v1/panes");
  assert.equal(open.body.from, undefined);
  assert.equal(open.body.direction, undefined);
  assert.equal(open.body.size, undefined);
});

test("termux-launcher opens a window instead of a split narrower than 88 columns", async (t) => {
  const launcher = await fakeLauncher(t, { "GET /v1/panes": panes({ columns: 87 }), "POST /v1/windows": ok });
  await terminalFor(launcher).split(splitRequest("left"));
  const open = launcher.requests.at(-1);
  assert.equal(open.url, "/v1/windows");
  assert.deepEqual(open.body.command, ["terminal-browser", "open", "en.wikipedia.org"]);
  assert.equal(open.body.title, "terminal-browser");
});

test("termux-launcher opens a window instead of a split shorter than 48 rows, but splits across when wide", async (t) => {
  const launcher = await fakeLauncher(t, {
    "GET /v1/panes": panes({ columns: 88, rows: 47 }),
    "POST /v1/panes": ok,
    "POST /v1/windows": ok,
  });
  const terminal = terminalFor(launcher);
  await terminal.split(splitRequest("down"));
  assert.equal(launcher.requests.at(-1).url, "/v1/windows");
  await terminal.split(splitRequest("right"));
  assert.equal(launcher.requests.at(-1).url, "/v1/panes");
});

test("termux-launcher splits a narrow pane when the launcher cannot open windows", async (t) => {
  const launcher = await fakeLauncher(t, {
    "GET /v1/panes": panes({ features: ["placement"], columns: 40 }),
    "POST /v1/panes": ok,
  });
  await terminalFor(launcher).split(splitRequest("right"));
  assert.equal(launcher.requests.at(-1).url, "/v1/panes");
});

test("termux-launcher lists every pane with its window as the tab and its shell's tty", async (t) => {
  const launcher = await fakeLauncher(t, { "GET /v1/panes": panes() });
  assert.deepEqual(await terminalFor(launcher).listPanes(), [
    { id: "p1", tab: "7", tty: "/dev/pts/1", command: null },
    { id: "p3", tab: "7", tty: "/dev/pts/3", command: null },
    { id: "p2", tab: "8", tty: "/dev/pts/2", command: null },
  ]);
});

test("termux-launcher asks the launcher once for listings close together", async (t) => {
  const launcher = await fakeLauncher(t, { "GET /v1/panes": panes() });
  const terminal = terminalFor(launcher);
  await terminal.listPanes();
  await terminal.listPanes();
  assert.equal(launcher.requests.length, 1);
});

test("termux-launcher finds the current pane by tty before the pane variable", async (t) => {
  const launcher = await fakeLauncher(t, { "GET /v1/panes": panes() });
  const terminal = terminalFor(launcher, { env: { TERMUX_LAUNCHER_PANE: "p1" } });
  assert.deepEqual(await terminal.getCurrentPane({ tty: "/dev/pts/2", cwd: "/" }), { id: "p2", tab: "8" });
  assert.deepEqual(await terminal.getCurrentPane({ tty: null, cwd: "/" }), { id: "p1", tab: "7" });
  assert.deepEqual(await terminal.getCurrentPane({ tty: "/dev/pts/9", cwd: "/" }), { id: "p1", tab: "7" });
});

test("termux-launcher finds the current pane through a parent's pane variable", async (t) => {
  const launcher = await fakeLauncher(t, { "GET /v1/panes": panes() });
  const terminal = terminalFor(launcher, { pid: 300 });
  assert.deepEqual(await terminal.getCurrentPane({ tty: null, cwd: "/" }), { id: "p3", tab: "7" });
});

test("termux-launcher finds the neighbor from the launcher's pane geometry", async (t) => {
  const launcher = await fakeLauncher(t, { "GET /v1/panes": panes() });
  const terminal = terminalFor(launcher);
  assert.deepEqual(await terminal.neighbor({ id: "p1", tab: "7" }, "right"), { id: "p3", tab: "7" });
  assert.equal(await terminal.neighbor({ id: "p1", tab: "7" }, "left"), null);
  assert.equal(await terminal.neighbor({ id: "p2", tab: "8" }, "right"), null);
});

test("termux-launcher types into and focuses a pane", async (t) => {
  const launcher = await fakeLauncher(t, { "POST /v1/panes/p3/write": ok, "POST /v1/panes/p3/focus": ok });
  const terminal = terminalFor(launcher);
  await terminal.sendText("p3", "hello");
  await terminal.sendText("p3", "a\nb");
  await terminal.focusPane("p3");
  assert.deepEqual(
    launcher.requests.map((request) => [request.url, request.body]),
    [
      ["/v1/panes/p3/write", { text: "hello" }],
      ["/v1/panes/p3/write", { text: "\x1b[200~a\nb\x1b[201~" }],
      ["/v1/panes/p3/focus", {}],
    ],
  );
});

test("termux-launcher says why the launcher refused", async (t) => {
  const launcher = await fakeLauncher(t, {
    "GET /v1/panes": refused(403, "panes_api_disabled"),
    "POST /v1/panes/p1/write": refused(403, "not_owned"),
    "POST /v1/panes/p1/focus": () => [401, { error: { message: "bad token", type: "unauthorized", code: null } }],
  });
  const terminal = terminalFor(launcher);
  await assert.rejects(terminal.listPanes(), /turn on "Let programs and agents control panes"/);
  await assert.rejects(terminal.sendText("p1", "x"), /only lets programs type into panes they opened themselves/);
  await assert.rejects(terminal.focusPane("p1"), /refused the token in ~\/\.launcherctl\/token/);
});

test("termux-launcher says the launcher is not running when its endpoint is missing", async () => {
  const terminal = launcherTerminal({ dir: path.join(os.tmpdir(), "tb-no-launcher"), env: {} });
  await assert.rejects(terminal.listPanes(), /endpoint is missing: is Termux Launcher running\?/);
});
