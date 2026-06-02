#!/usr/bin/env node
/**
 * Docs MCP Server — Streamable HTTP with FTS5 SQLite (better-sqlite3).
 * Tools: search_docs, get_page
 * Health: /health → { ok: true } (no DB touch)
 */
import { createServer, IncomingMessage, ServerResponse } from "http";
const DatabaseConstructor = require("better-sqlite3");
const Database = DatabaseConstructor as any;

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
const AUTH_MODE = process.env.AUTH_MODE || "none";
const ALLOWED_DOMAIN = process.env.ALLOWED_DOMAIN || "";

// Resolve DB path: env > default
let dbPath = process.env.DB_PATH || "/app/data/db/docs.sqlite";
if (!require("fs").existsSync(dbPath)) {
  // Fallback for local dev
  const localPath = require("path").join(__dirname, "..", "data", "db", "docs.sqlite");
  if (require("fs").existsSync(localPath)) {
    dbPath = localPath;
  }
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

function parseBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString()));
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function checkAuth(req: IncomingMessage): boolean {
  if (AUTH_MODE === "none") return true;
  // OAuth mode: check cookie/session (placeholder for stage 2)
  const cookie = req.headers.cookie || "";
  const match = cookie.match(/session=([^;]+)/);
  if (!match) return false;
  try {
    const payload = JSON.parse(Buffer.from(match[1], "base64url").toString());
    if (ALLOWED_DOMAIN && payload.domain !== ALLOWED_DOMAIN) return false;
    if (Date.now() > payload.exp) return false;
    return true;
  } catch {
    return false;
  }
}

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
    if (!row) {
      return { ...base, error: { code: -32000, message: `Doc not found: ${path}` } };
    }
    return { ...base, result: { content: [{ type: "text", text: row.content }] } };
  }

  return { ...base, error: { code: -32601, message: `Unknown tool: ${name}` } };
}

function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  return new Promise(async (resolve) => {
    try {
      // CORS
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        resolve();
        return;
      }

      const url = req.url || "";

      // Health check — no DB touch
      if (url === "/health") {
        json(res, 200, { ok: true });
        resolve();
        return;
      }

      // Auth check
      if (!checkAuth(req)) {
        json(res, 401, { ok: false, error: "Unauthorized" });
        resolve();
        return;
      }

      // MCP Endpoint
      if (url === "/mcp" && req.method === "POST") {
        const body = await parseBody(req);
        let request: any;
        try {
          request = JSON.parse(body);
        } catch (e) {
          json(res, 200, {
            jsonrpc: "2.0",
            id: null,
            error: { code: -32700, message: "Parse error" },
          });
          resolve();
          return;
        }

        if (request.method === "tools/list") {
          json(res, 200, {
            jsonrpc: "2.0",
            id: request.id,
            result: { tools: TOOLS },
          });
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
              capabilities: { tools: {} },
              serverInfo: { name: "docs-mcp", version: "1.0.0" },
            },
          });
          resolve();
          return;
        }

        json(res, 200, {
          jsonrpc: "2.0",
          id: request.id,
          error: { code: -32601, message: "Method not found" },
        });
        resolve();
        return;
      }

      json(res, 404, { error: "Not found" });
      resolve();
    } catch (err) {
      console.error("Request error:", err);
      json(res, 500, { error: String(err) });
      resolve();
    }
  });
}

const server = createServer((req, res) => {
  handleRequest(req, res).catch((err) => {
    console.error("Request error:", err);
    json(res, 500, { error: String(err) });
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Docs MCP server listening on http://${HOST}:${PORT}`);
  console.log(`Auth mode: ${AUTH_MODE}`);
  console.log(`DB: ${dbPath}`);
});

process.on("SIGTERM", () => {
  console.log("SIGTERM received, shutting down...");
  try { db?.close(); db = null; } catch {}
  server.close(() => process.exit(0));
});
