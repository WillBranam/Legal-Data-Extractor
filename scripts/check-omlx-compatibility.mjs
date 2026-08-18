#!/usr/bin/env node
// Checks whether an OpenAI-compatible local server (oMLX) supports the two
// behaviors src/lib/local-llm.ts depends on:
//   1. JSON Schema constrained decoding, so structured extraction conforms.
//   2. A "length" finish reason, so truncated output is classified rather than
//      surfacing as a JSON SyntaxError.
//
// Usage:
//   node scripts/check-omlx-compatibility.mjs
//   OMLX_BASE_URL=http://127.0.0.1:8000 OMLX_MODEL=mlx-community/Qwen3-8B-4bit \
//     node scripts/check-omlx-compatibility.mjs
//
// The API key is read from ~/.omlx/settings.json unless LOCAL_LLM_API_KEY is
// set. It is never printed. Synthetic content only.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const BASE_URL = process.env.OMLX_BASE_URL ?? "http://127.0.0.1:8000";
const LOOPBACK = ["127.0.0.1", "localhost", "[::1]"];

function apiKey() {
  if (process.env.LOCAL_LLM_API_KEY) return process.env.LOCAL_LLM_API_KEY;
  try {
    const settings = JSON.parse(readFileSync(join(homedir(), ".omlx", "settings.json"), "utf8"));
    return settings?.auth?.api_key ?? "";
  } catch {
    return "";
  }
}

const KEY = apiKey();
const headers = {
  "Content-Type": "application/json",
  ...(KEY ? { Authorization: `Bearer ${KEY}` } : {})
};

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? "  PASS" : "  FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

async function main() {
  console.log(`oMLX compatibility check against ${BASE_URL}\n`);

  const url = new URL(BASE_URL);
  console.log("Boundary");
  record(
    "server is loopback-only",
    LOOPBACK.includes(url.hostname),
    `hostname ${url.hostname}`
  );
  record("API key available", Boolean(KEY), KEY ? "read from settings" : "set LOCAL_LLM_API_KEY or configure oMLX auth");

  console.log("\nModels");
  let models = [];
  try {
    const response = await fetch(new URL("/v1/models", BASE_URL), { headers });
    if (!response.ok) {
      record("GET /v1/models", false, `HTTP ${response.status}${response.status === 401 ? " (auth rejected)" : ""}`);
      return summarize();
    }
    const body = await response.json();
    models = (body.data ?? []).map((item) => item.id);
    record("GET /v1/models", true, `${models.length} model(s)`);
  } catch (error) {
    record("GET /v1/models", false, error.message);
    return summarize();
  }

  if (models.length === 0) {
    console.log("\n  No models installed. Ollama GGUF weights cannot be used by MLX.");
    console.log("  Install an MLX build first, for example:");
    console.log("    omlx serve mlx-community/Qwen3-8B-4bit --port 8000");
    return summarize();
  }

  const model = process.env.OMLX_MODEL ?? models[0];
  console.log(`\nStructured output  (model: ${model})`);

  // The schema mirrors the shape extractWithLocalModel relies on.
  const schema = {
    type: "object",
    properties: {
      document_type: { type: "string" },
      fields: {
        type: "array",
        maxItems: 4,
        items: {
          type: "object",
          properties: {
            source_label: { type: "string" },
            raw_value: { type: "string" }
          },
          required: ["source_label", "raw_value"]
        }
      }
    },
    required: ["document_type", "fields"]
  };

  const source = [
    "CIVIL CASE COVER SHEET",
    "Case Number: 24STCV18432",
    "Filing Date: March 14, 2024",
    "Plaintiff: Maria Elena Sanchez-Rivera",
    "Claim Number: NS-2024-004417"
  ].join("\n");

  async function chat(body) {
    const response = await fetch(new URL("/v1/chat/completions", BASE_URL), {
      method: "POST",
      headers,
      body: JSON.stringify({ model, stream: false, temperature: 0, ...body })
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
    return JSON.parse(text);
  }

  let schemaEnforced = false;
  try {
    const body = await chat({
      max_tokens: 800,
      response_format: {
        type: "json_schema",
        json_schema: { name: "extraction", schema, strict: true }
      },
      messages: [
        { role: "system", content: "Extract labeled administrative fields. Return JSON only." },
        { role: "user", content: source }
      ]
    });
    const content = body.choices?.[0]?.message?.content ?? "";
    record("response_format json_schema accepted", true, `${content.length} chars`);
    try {
      const parsed = JSON.parse(content);
      const conforms = typeof parsed.document_type === "string" && Array.isArray(parsed.fields);
      schemaEnforced = conforms;
      record("output parses and conforms to schema", conforms, conforms ? `${parsed.fields.length} field(s)` : "shape mismatch");
    } catch {
      record("output parses and conforms to schema", false, "JSON.parse failed — schema is not enforced");
    }
    record(
      "response exposes choices[0].finish_reason",
      typeof body.choices?.[0]?.finish_reason === "string",
      `finish_reason=${body.choices?.[0]?.finish_reason}`
    );
  } catch (error) {
    record("response_format json_schema accepted", false, error.message);
  }

  console.log("\nTruncation signal");
  // Deliberately starve the budget. The server must report a length stop so the
  // client can classify truncation instead of throwing a SyntaxError.
  try {
    const body = await chat({
      max_tokens: 12,
      response_format: {
        type: "json_schema",
        json_schema: { name: "extraction", schema, strict: true }
      },
      messages: [
        { role: "system", content: "Extract every labeled administrative field. Return JSON only." },
        { role: "user", content: source }
      ]
    });
    const finish = body.choices?.[0]?.finish_reason;
    const content = body.choices?.[0]?.message?.content ?? "";
    let parses = true;
    try { JSON.parse(content); } catch { parses = false; }
    record(
      'reports finish_reason "length" when budget is exhausted',
      finish === "length",
      `finish_reason=${finish}, output ${parses ? "parses" : "is truncated"}`
    );
    if (finish !== "length" && !parses) {
      console.log("\n  WARNING: output was truncated but no length signal was given.");
      console.log("  Truncation detection in local-llm.ts would not fire on this server.");
    }
  } catch (error) {
    record('reports finish_reason "length" when budget is exhausted', false, error.message);
  }

  if (!schemaEnforced) {
    console.log("\n  WARNING: schema conformance not confirmed. Ollama's `format` guarantees");
    console.log("  schema-valid output; without an equivalent guarantee, expect more");
    console.log("  extraction failures and validate recall before trusting this server.");
  }

  summarize();
}

function summarize() {
  const failed = results.filter((item) => !item.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  if (failed.length > 0) {
    console.log("Blocking before switching the app to oMLX:");
    for (const item of failed) console.log(`  - ${item.name}`);
  }
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(`\nCheck aborted: ${error.message}`);
  process.exit(1);
});
