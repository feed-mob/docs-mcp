#!/usr/bin/env node
/**
 * Docs MCP Server — Streamable HTTP with FTS5 SQLite (better-sqlite3) + Google OAuth.
 * Tools: search_docs, get_page
 * Health: /health → { ok: true } (no DB touch)
 * Auth: /auth/google → Google OAuth → /auth/google/callback → session cookie
 */
import { createServer, IncomingMessage, ServerResponse } from "http";
import { request as httpsRequest } from "https";
import { randomBytes, createHash } from "crypto";
const DatabaseConstructor = require("better-sqlite3");
const Database = DatabaseConstructor as any;

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
const AUTH_MODE = process.env.AUTH_MODE || "none";
const ALLOWED_DOMAIN = process.env.ALLOWED_DOMAIN || "";
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
const BASE_URL = (process.env.BASE_URL || "").replace(/\/$/, ""); // strip trailing /

// Resolve DB path: env > default
let dbPath = process.env.DB_PATH || "/app/data/db/docs.sqlite";
if (!require("fs").existsSync(dbPath)) {
  const localPath = require("path").join(__dirname, "..", "data", "db", "docs.sqlite");
  if (require("fs").existsSync(localPath)) dbPath = localPath;
}

interface JSONRPCResponse {
  jsonrpc: string;
  id: string | number | null;
  result?: any;
  error?: { code: number; message: string; data?: any };
}

interface DBInstance {
  prepare: (sql: string, ...params: any[]) => any;
  close: () => void;
}

let db: DBInstance | null = null;
function getDb(): DBInstance {
  if (db) return db;
  db = new Database(dbPath);
  return db!;
}

function json(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function html(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  res.end(body);
}

function redirect(res: ServerResponse, location: string, status = 302): void {
  res.writeHead(status, { Location: location });
  res.end();
}

function parseBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString()));
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

// --- Session helpers ---
function signSession(payload: object, secret: string): string {
  const data = JSON.stringify(payload);
  const sig = createHash("sha256").update(data + secret).digest("base64url").slice(0, 16);
  return Buffer.from(data).toString("base64url") + "." + sig;
}

function unsignSession(token: string, secret: string): object | null {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [dataB64, sig] = parts;
  try {
    const data = Buffer.from(dataB64, "base64url").toString("utf-8");
    const expected = createHash("sha256").update(data + secret).digest("base64url").slice(0, 16);
    if (sig !== expected) return null;
    return JSON.parse(data);
  } catch {
    return null;
  }
}

function setCookie(res: ServerResponse, name: string, value: string, maxAge = 86400): void {
  const isSecure = BASE_URL.startsWith("https://");
  const cookie = `${name}=${value}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAge}${isSecure ? "; Secure" : ""}`;
  const existing = res.getHeader("Set-Cookie");
  if (existing) {
    const arr: string[] = Array.isArray(existing) ? [...existing, cookie] : [String(existing), cookie];
    res.setHeader("Set-Cookie", arr);
  } else {
    res.setHeader("Set-Cookie", cookie);
  }
}

function getCookies(req: IncomingMessage): Record<string, string> {
  const raw = req.headers.cookie || "";
  const out: Record<string, string> = {};
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k) out[k] = v.join("=");
  }
  return out;
}

function checkAuth(req: IncomingMessage): { email: string; domain: string } | null {
  if (AUTH_MODE === "none") return { email: "anonymous", domain: "" };
  const cookies = getCookies(req);
  const session = cookies["session"];
  if (!session) return null;
  const payload = unsignSession(session, GOOGLE_CLIENT_SECRET || "dev-secret");
  if (!payload || typeof payload !== "object") return null;
  const { email, domain, exp } = payload as any;
  if (!email || !domain || Date.now() > (exp || 0)) return null;
  if (ALLOWED_DOMAIN && domain !== ALLOWED_DOMAIN) return null;
  return { email, domain };
}

// --- HTTP helpers ---
function postJson(url: string, body: object): Promise<any> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = JSON.stringify(body);
    const req = httpsRequest(
      {
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
        },
      },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(body));
          } catch {
            resolve({ raw: body });
          }
        });
      }
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

function getJson(url: string, headers: Record<string, string> = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = httpsRequest(
      {
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        method: "GET",
        headers,
      },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(body));
          } catch {
            resolve({ raw: body });
          }
        });
      }
    );
    req.on("error", reject);
    req.end();
  });
}

// --- HTML pages ---
function loginPage(): string {
  const loginUrl = `${BASE_URL}/auth/google`;
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Docs MCP</title>
<style>body{font-family:system-ui,-apple-system,sans-serif;max-width:600px;margin:80px auto;padding:20px;text-align:center}
h1{color:#333}a{display:inline-block;padding:12px 24px;background:#4285f4;color:#fff;text-decoration:none;border-radius:4px;font-weight:500}
a:hover{background:#357ae8}</style></head>
<body><h1>:books: Docs MCP Server</h1><p>Search docs via MCP. Login required.</p><a href="${loginUrl}">:bust_in_silhouette: Login with Google</a></body></html>`;
}

function loggedInPage(email: string): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Docs MCP</title>
<style>body{font-family:system-ui,-apple-system,sans-serif;max-width:600px;margin:80px auto;padding:20px}
h1{color:#333}.ok{color:#2e7d32;font-weight:500}</style></head>
<body><h1>:books: Docs MCP Server</h1><p class="ok">:white_check_mark: Logged in as <strong>${email}</strong></p>
<p>Endpoints:</p><ul><li><code>/health</code> — health check</li><li><code>/mcp</code> — MCP JSON-RPC</li><li><code>/tools/list</code> — list tools</li></ul>
<p><a href="${BASE_URL}/logout">Logout</a></p></body></html>`;
}

function deniedPage(domain: string): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Access Denied</title>
<style>body{font-family:system-ui,-apple-system,sans-serif;max-width:600px;margin:80px auto;padding:20px;text-align:center;color:#c62828}</style></head>
<body><h1>:no_entry_sign: Access Denied</h1><p>Email domain must be <strong>@${domain}</strong>.</p>
<p><a href="${BASE_URL}/auth/google">Try another account</a> | <a href="${BASE_URL}/logout">Clear session</a></p></body></html>`;
}

// --- Tools ---
const TOOLS = [
  {
    name: "search_docs",
    description: "FTS5 keyword search across docs",
    inputSchema: {
      type: "object" as const,
      properties: {
        q: { type: "string", description: "FTS5 query, e.g. 'Coolify deployment'" },
        limit: { type: "number", default: 10 },
      },
      required: ["q"],
    },
  },
  {
    name: "get_page",
    description: "Retrieve full content of a single doc by path",
    inputSchema: {
      type: "object" as const,
      properties: {
        path: { type: "string", description: "Doc path, e.g. 'deployment-guide.md'" },
      },
      required: ["path"],
    },
  },
];

async function handleToolCall(name: string, args: any): Promise<JSONRPCResponse> {
  const base: JSONRPCResponse = { jsonrpc: "2.0", id: null };
  if (name === "search_docs") {
    const q = String(args.q || "").replace(/"/g, '""');
    const limit = Math.min(Math.max(Number(args.limit || 10), 1), 50);
    const stmt = getDb().prepare(
      `SELECT d.path, d.title, snippet(docs_fts, 1, '**', '**', '…', 60) AS snippet
       FROM docs_fts JOIN docs d ON docs_fts.rowid = d.id WHERE docs_fts MATCH ? LIMIT ?`
    );
    const rows = stmt.all(q, limit);
    return { ...base, result: { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] } };
  }
  if (name === "get_page") {
    const path = String(args.path || "");
    const stmt = getDb().prepare(`SELECT path, title, content FROM docs WHERE path = ?`);
    const row = stmt.get(path) as any;
    if (!row) return { ...base, error: { code: -32000, message: `Doc not found: ${path}` } };
    return { ...base, result: { content: [{ type: "text", text: row.content }] } };
  }
  return { ...base, error: { code: -32601, message: `Unknown tool: ${name}` } };
}

// --- Main request handler ---
function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  return new Promise(async (resolve) => {
    try {
      // CORS
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        resolve();
        return;
      }

      const url = req.url || "";
      const method = req.method || "GET";

      // --- Public endpoints (no auth) ---
      if (url === "/health") {
        json(res, 200, { ok: true });
        resolve();
        return;
      }

      // OAuth: initiate login
      if (url === "/auth/google" && method === "GET") {
        if (!GOOGLE_CLIENT_ID || !BASE_URL) {
          json(res, 500, { ok: false, error: "OAuth not configured" });
          resolve();
          return;
        }
        const state = randomBytes(16).toString("hex");
        setCookie(res, "oauth_state", state, 600); // 10 min
        const redirectUri = `${BASE_URL}/auth/google/callback`;
        const googleUrl =
          "https://accounts.google.com/o/oauth2/v2/auth?" +
          `client_id=${encodeURIComponent(GOOGLE_CLIENT_ID)}` +
          `&redirect_uri=${encodeURIComponent(redirectUri)}` +
          `&response_type=code` +
          `&scope=${encodeURIComponent("openid email profile")}` +
          `&state=${encodeURIComponent(state)}` +
          `&access_type=offline`;
        redirect(res, googleUrl);
        resolve();
        return;
      }

      // OAuth: callback
      if (url.startsWith("/auth/google/callback") && method === "GET") {
        const u = new URL(url, `http://localhost`);
        const code = u.searchParams.get("code");
        const state = u.searchParams.get("state");
        const error = u.searchParams.get("error");
        const cookies = getCookies(req);

        if (error) {
          html(res, 400, `<h1>OAuth Error</h1><p>${error}</p><a href="${BASE_URL}/">Home</a>`);
          resolve();
          return;
        }

        // Verify state
        if (!state || state !== cookies["oauth_state"]) {
          html(res, 403, `<h1>Invalid state</h1><p>CSRF protection triggered.</p><a href="${BASE_URL}/">Home</a>`);
          resolve();
          return;
        }

        if (!code) {
          html(res, 400, `<h1>No code</h1><p>Google did not return an authorization code.</p><a href="${BASE_URL}/">Home</a>`);
          resolve();
          return;
        }

        // Exchange code for tokens
        try {
          const tokenRes = await postJson("https://oauth2.googleapis.com/token", {
            code,
            client_id: GOOGLE_CLIENT_ID,
            client_secret: GOOGLE_CLIENT_SECRET,
            redirect_uri: `${BASE_URL}/auth/google/callback`,
            grant_type: "authorization_code",
          });

          if (tokenRes.error) {
            html(res, 400, `<h1>Token Error</h1><pre>${JSON.stringify(tokenRes, null, 2)}</pre><a href="${BASE_URL}/">Home</a>`);
            resolve();
            return;
          }

          const accessToken = tokenRes.access_token;
          if (!accessToken) {
            html(res, 500, `<h1>No access token</h1><a href="${BASE_URL}/">Home</a>`);
            resolve();
            return;
          }

          // Get user info
          const userInfo = await getJson("https://www.googleapis.com/oauth2/v2/userinfo", {
            Authorization: `Bearer ${accessToken}`,
          });

          const email = userInfo.email;
          if (!email) {
            html(res, 500, `<h1>No email from Google</h1><pre>${JSON.stringify(userInfo, null, 2)}</pre><a href="${BASE_URL}/">Home</a>`);
            resolve();
            return;
          }

          const domain = email.split("@")[1] || "";

          // Check allowed domain
          if (ALLOWED_DOMAIN && domain !== ALLOWED_DOMAIN) {
            html(res, 403, deniedPage(ALLOWED_DOMAIN));
            resolve();
            return;
          }

          // Create session
          const exp = Date.now() + 7 * 24 * 60 * 60 * 1000; // 7 days
          const sessionToken = signSession({ email, domain, exp }, GOOGLE_CLIENT_SECRET || "dev-secret");
          setCookie(res, "session", sessionToken, 7 * 24 * 60 * 60);
          setCookie(res, "oauth_state", "", 0); // clear state

          redirect(res, `${BASE_URL}/`);
        } catch (err: any) {
          html(res, 500, `<h1>OAuth Error</h1><p>${err.message || "Unknown error"}</p><a href="${BASE_URL}/">Home</a>`);
        }
        resolve();
        return;
      }

      // Logout
      if (url === "/logout" && method === "GET") {
        setCookie(res, "session", "", 0);
        redirect(res, `${BASE_URL}/`);
        resolve();
        return;
      }

      // --- Auth check (for protected routes) ---
      const user = checkAuth(req);
      if (!user) {
        if (url === "/" && method === "GET") {
          html(res, 200, loginPage());
        } else {
          json(res, 401, { ok: false, error: "Unauthorized" });
        }
        resolve();
        return;
      }

      // --- Protected endpoints ---
      if (url === "/" && method === "GET") {
        html(res, 200, loggedInPage(user.email));
        resolve();
        return;
      }

      if (url === "/tools/list" && method === "GET") {
        json(res, 200, { tools: TOOLS });
        resolve();
        return;
      }

      // MCP Endpoint
      if (url === "/mcp" && method === "POST") {
        const body = await parseBody(req);
        let request: any;
        try {
          request = JSON.parse(body);
        } catch (e) {
          json(res, 200, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
          resolve();
          return;
        }

        if (request.method === "tools/list") {
          json(res, 200, { jsonrpc: "2.0", id: request.id, result: { tools: TOOLS } });
          resolve();
          return;
        }

        if (request.method === "tools/call") {
          const { name, arguments: args = {} } = request.params || {};
          const result = await handleToolCall(name, args);
          result.id = request.id;
          json(res, 200, result);
          resolve();
          return;
        }

        if (request.method === "initialize") {
          json(res, 200, {
            jsonrpc: "2.0",
            id: request.id,
            result: {
              protocolVersion: "2024-11-05",
              capabilities: {},
              serverInfo: { name: "docs-mcp", version: "1.0.0" },
            },
          });
          resolve();
          return;
        }

        json(res, 200, { jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Method not found" } });
        resolve();
        return;
      }

      // 404
      json(res, 404, { ok: false, error: "Not found" });
      resolve();
    } catch (err: any) {
      console.error("[http] error:", err);
      json(res, 500, { ok: false, error: err.message || "Internal error" });
      resolve();
    }
  });
}

// Start
const server = createServer((req, res) => {
  handleRequest(req, res);
});

server.listen(PORT, HOST, () => {
  console.log(`Docs MCP server listening on http://${HOST}:${PORT}`);
  console.log(`Auth mode: ${AUTH_MODE}`);
  console.log(`DB: ${dbPath}`);
});
