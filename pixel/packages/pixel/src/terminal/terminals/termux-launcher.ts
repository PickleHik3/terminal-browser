import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { adjacentPane, bracketedPaste } from "../shared";
import type { PaneRect } from "../shared";
import type { Detect, Direction, Pane, PaneDetails, Terminal } from "../terminal";

const LISTING_TTL_MS = 500;
const HTTP_TIMEOUT_MS = 6000;
const MIN_SPLIT_COLUMNS = 88;
const MIN_SPLIT_ROWS = 48;

interface Geometry {
  left: number;
  top: number;
  columns: number;
  rows: number;
}

interface LauncherPane extends Pane {
  pid: number | null;
  columns: number | null;
  rows: number | null;
  floating: boolean;
  geometry: Geometry | null;
}

interface Listing {
  panes: LauncherPane[];
  features: string[];
}

type Body = Record<string, unknown>;

export interface LauncherTerminalOptions {
  dir: string;
  env: NodeJS.ProcessEnv;
  procRoot?: string;
  pid?: number;
  now?: () => number;
  timeout?: number;
}

const isRecord = (value: unknown): value is Body => typeof value === "object" && value !== null;
const finite = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

function refusal(status: number, body: unknown): string {
  const record = isRecord(body) ? body : {};
  const nested = isRecord(record.error) ? record.error : null;
  const code = String((nested ? nested.code : record.error) || record.code || record.error_code || "");
  const said = String(record.message || nested?.message || "");
  switch (code) {
    case "panes_api_disabled":
      return 'the launcher does not let programs open or drive panes: turn on "Let programs and agents control panes" in the launcher\'s settings';
    case "splits_disabled":
      return "the launcher cannot open a pane while its compatibility mode is on (split panes are off)";
    case "activity_not_running":
      return "Termux Launcher is not running: open it and try again";
    case "not_owned":
      return "the launcher only lets programs type into panes they opened themselves, and this pane was opened by hand";
    case "pane_not_found":
      return `the launcher has no such pane${said ? ` (${said})` : ""}`;
    case "pane_not_tiled":
      return "the launcher cannot open a pane beside a floating pane";
    case "pane_open_failed":
      return `the launcher could not open a pane${said ? `: ${said}` : ""}`;
    case "window_open_failed":
      return `the launcher could not open a window${said ? `: ${said}` : ""}`;
    case "unauthorized":
      return "the launcher refused the token in ~/.launcherctl/token (it changes when the launcher restarts; try again)";
    default:
      if (status === 401) return refusal(status, { error: "unauthorized" });
      return `the launcher answered HTTP ${status}${code ? ` ${code}` : ""}${said ? `: ${said}` : ""}`;
  }
}

function launcherApi(dir: string, timeout: number) {
  function connection(): { base: string; token: string } {
    let base: string;
    try {
      base = fs.readFileSync(path.join(dir, "endpoint"), "utf8").split("\n")[0].trim();
    } catch {
      throw new Error(`${path.join(dir, "endpoint")} is missing: is Termux Launcher running?`);
    }
    let token = "";
    try {
      token = fs.readFileSync(path.join(dir, "token"), "utf8").trim();
    } catch {}
    return { base, token };
  }

  return function call(method: "GET" | "POST", route: string, body?: Body): Promise<Body> {
    const { base, token } = connection();
    const url = new URL(route, base);
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const headers: Record<string, string> = { Accept: "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (payload) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = String(payload.length);
    }
    return new Promise((resolve, reject) => {
      const request = http.request(
        { hostname: url.hostname, port: url.port, path: url.pathname + url.search, method, headers },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () => {
            let parsed: unknown = null;
            try {
              parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            } catch {}
            const status = response.statusCode ?? 0;
            if (status >= 400 || (isRecord(parsed) && parsed.ok === false)) {
              reject(new Error(refusal(status, parsed)));
            } else if (!isRecord(parsed)) {
              reject(new Error(`the launcher answered ${method} ${route} with something that is not json`));
            } else {
              resolve(parsed);
            }
          });
        },
      );
      request.setTimeout(timeout, () => request.destroy(new Error("timeout")));
      request.on("error", (error: NodeJS.ErrnoException) =>
        reject(
          new Error(
            error.message === "timeout"
              ? `the launcher did not answer ${method} ${route} within ${timeout / 1000}s`
              : `cannot reach the launcher at ${base} (${error.code ?? error.message}): is Termux Launcher running?`,
          ),
        ),
      );
      if (payload) request.write(payload);
      request.end();
    });
  };
}

function procfs(root: string) {
  // the process name inside the parentheses may itself contain spaces and parentheses
  function stat(pid: number): { ppid: number; ttyNr: number } | null {
    try {
      const text = fs.readFileSync(`${root}/${pid}/stat`, "utf8");
      const fields = text.slice(text.lastIndexOf(")") + 2).split(" ");
      return { ppid: Number(fields[1]), ttyNr: Number(fields[4]) };
    } catch {
      return null;
    }
  }

  function tty(pid: number): string | null {
    for (const fd of [0, 1, 2]) {
      try {
        const target = fs.readlinkSync(`${root}/${pid}/fd/${fd}`);
        if (target.startsWith("/dev/") && target !== "/dev/null") return target;
      } catch {}
    }
    return null;
  }

  return {
    tty,
    parent(pid: number): number {
      const found = stat(pid);
      return found && Number.isInteger(found.ppid) ? found.ppid : 0;
    },
    environ(pid: number, name: string): string | null {
      try {
        const prefix = `${name}=`;
        const entry = fs
          .readFileSync(`${root}/${pid}/environ`, "utf8")
          .split("\0")
          .find((line) => line.startsWith(prefix));
        return entry === undefined ? null : entry.slice(prefix.length);
      } catch {
        return null;
      }
    },
    onTty(pid: number, device: string): boolean {
      if (tty(pid) === device) return true;
      const found = stat(pid);
      if (!found?.ttyNr) return false;
      try {
        return fs.statSync(device).rdev === found.ttyNr;
      } catch {
        return false;
      }
    },
  };
}

function geometry(value: unknown): Geometry | null {
  if (!isRecord(value)) return null;
  const [left, top, columns, rows] = [value.left, value.top, value.columns, value.rows].map(finite);
  if (left === null || top === null || columns === null || rows === null) return null;
  return { left, top, columns, rows };
}

function paneRect(pane: LauncherPane): PaneRect | null {
  const g = pane.geometry;
  if (!g) return null;
  return { id: pane.id, left: g.left, top: g.top, right: g.left + g.columns - 1, bottom: g.top + g.rows - 1 };
}

// a pane the launcher opened keeps its shell when the command exits, so a browser that quits
// cleanly closes its own pane, as it would in kitty or tmux; a failure leaves the error on screen
function closingCommand(argv: string[]): string[] {
  const script =
    'if "$@"; then [ -n "$TERMUX_LAUNCHER_PANE" ] && command -v launcherctl >/dev/null 2>&1 &&' +
    ' launcherctl pane close "$TERMUX_LAUNCHER_PANE" >/dev/null 2>&1; fi';
  return ["sh", "-c", script, "terminal-browser", ...argv];
}

function tooNarrow(pane: LauncherPane, direction: Direction): boolean {
  const across = direction === "right" || direction === "left";
  const cells = across ? pane.geometry?.columns ?? pane.columns : pane.geometry?.rows ?? pane.rows;
  if (cells === null || cells <= 0) return false;
  return cells < (across ? MIN_SPLIT_COLUMNS : MIN_SPLIT_ROWS);
}

export function launcherTerminal({
  dir,
  env,
  procRoot = "/proc",
  pid = process.pid,
  now = Date.now,
  timeout = HTTP_TIMEOUT_MS,
}: LauncherTerminalOptions): Terminal {
  const call = launcherApi(dir, timeout);
  const proc = procfs(procRoot);
  let cached: { at: number; promise: Promise<Listing> } | null = null;

  function listing(): Promise<Listing> {
    if (cached && now() - cached.at < LISTING_TTL_MS) return cached.promise;
    const promise = call("GET", "/v1/panes").then((body): Listing => {
      const panes: LauncherPane[] = [];
      for (const window of Array.isArray(body.windows) ? body.windows : []) {
        if (!isRecord(window)) continue;
        const tab = String(window.id ?? window.index);
        for (const pane of Array.isArray(window.panes) ? window.panes : []) {
          if (!isRecord(pane) || pane.id == null) continue;
          panes.push({
            id: String(pane.id),
            tab,
            pid: Number.isInteger(pane.pid) ? (pane.pid as number) : null,
            columns: finite(pane.columns),
            rows: finite(pane.rows),
            floating: pane.floating === true,
            geometry: geometry(pane.geometry),
          });
        }
      }
      const features = Array.isArray(body.features) ? body.features.map(String) : [];
      return { panes, features };
    });
    const entry = { at: now(), promise };
    cached = entry;
    promise.catch(() => {
      if (cached === entry) cached = null;
    });
    return promise;
  }

  const brief = (pane: LauncherPane | undefined | null): Pane | null => (pane ? { id: pane.id, tab: pane.tab } : null);

  // the browser asks from its daemon, whose environment names whichever pane started it,
  // so the tty it passes (its own) is the better witness
  async function currentPane(tty: string | null): Promise<LauncherPane | null> {
    const { panes } = await listing();
    if (tty) {
      const owner = panes.find((pane) => pane.pid !== null && proc.onTty(pane.pid, tty));
      if (owner) return owner;
    }
    const named = env.TERMUX_LAUNCHER_PANE && panes.find((pane) => pane.id === env.TERMUX_LAUNCHER_PANE);
    if (named) return named;
    let ancestor = proc.parent(pid);
    for (let hops = 0; hops < 64 && ancestor > 1; hops++) {
      const shell = panes.find((pane) => pane.pid === ancestor);
      if (shell) return shell;
      const id = proc.environ(ancestor, "TERMUX_LAUNCHER_PANE");
      const pane = id && panes.find((candidate) => candidate.id === id);
      if (pane) return pane;
      ancestor = proc.parent(ancestor);
    }
    return null;
  }

  return {
    name: "termux-launcher",
    async getCurrentPane(context) {
      return brief(await currentPane(context.tty));
    },
    async split({ from, direction, command, size }) {
      const { panes, features } = await listing();
      const source = panes.find((pane) => pane.id === from.id);
      if (features.includes("windows") && source && tooNarrow(source, direction)) {
        await call("POST", "/v1/windows", { command, title: "terminal-browser", cwd: process.cwd(), focus: true });
      } else {
        const body: Body = {
          command: closingCommand(command),
          cwd: process.cwd(),
          focus: false,
          title: "terminal-browser",
          tag: "terminal-browser",
        };
        if (features.includes("placement")) {
          body.from = from.id;
          body.direction = direction;
          if (size !== null && Number.isFinite(size)) body.size = Math.min(0.9, Math.max(0.1, size));
        }
        await call("POST", "/v1/panes", body);
      }
      cached = null;
    },
    async listPanes(): Promise<PaneDetails[]> {
      const { panes } = await listing();
      return panes.map((pane) => ({
        id: pane.id,
        tab: pane.tab,
        tty: pane.pid !== null ? proc.tty(pane.pid) : null,
        command: null,
      }));
    },
    async neighbor(from, direction) {
      const { panes } = await listing();
      const source = panes.find((pane) => pane.id === from.id);
      const rect = source && !source.floating ? paneRect(source) : null;
      if (!source || !rect) return null;
      const candidates = panes
        .filter((pane) => pane.tab === source.tab && !pane.floating)
        .map(paneRect)
        .filter((candidate): candidate is PaneRect => candidate !== null);
      const found = adjacentPane(rect, candidates, direction);
      return found ? brief(panes.find((pane) => pane.id === found.id)) : null;
    },
    async sendText(pane, text) {
      await call("POST", `/v1/panes/${encodeURIComponent(pane)}/write`, { text: bracketedPaste(text) });
    },
    async focusPane(pane) {
      await call("POST", `/v1/panes/${encodeURIComponent(pane)}/focus`, {});
    },
  };
}

export const termuxLauncher: Detect = (env) => {
  if (env.TERM_PROGRAM !== "termux-launcher" && !env.TERMUX_LAUNCHER_PANE) return null;
  return launcherTerminal({ dir: path.join(env.HOME ?? os.homedir(), ".launcherctl"), env });
};
