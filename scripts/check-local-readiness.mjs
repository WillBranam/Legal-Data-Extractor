import { access, stat } from "node:fs/promises";
import path from "node:path";

const minimumNode = [20, 18, 0];
const currentNode = process.versions.node.split(".").map(Number);
const model = process.env.LOCAL_LLM_MODEL?.trim() || "qwen3:8b";
const failures = [];
const passes = [];
let endpoint;
try {
  endpoint = new URL(
    process.env.LOCAL_LLM_BASE_URL || "http://127.0.0.1:11434"
  );
} catch {
  failures.push("LOCAL_LLM_BASE_URL must be a valid URL");
}

if (
  !/^[a-zA-Z0-9][a-zA-Z0-9._/:+-]{0,127}$/.test(model) ||
  model.includes("://") ||
  model.toLowerCase().includes("cloud")
) {
  failures.push("LOCAL_LLM_MODEL must identify a locally installed, non-cloud model");
}

function atLeast(current, minimum) {
  for (let index = 0; index < minimum.length; index += 1) {
    if (current[index] > minimum[index]) return true;
    if (current[index] < minimum[index]) return false;
  }
  return true;
}

if (atLeast(currentNode, minimumNode)) passes.push(`Node ${process.versions.node}`);
else failures.push(`Node ${minimumNode.join(".")} or newer is required`);

const validEndpoint = Boolean(endpoint) &&
  endpoint.protocol === "http:" &&
  ["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname);
if (validEndpoint) {
  passes.push(`Local model endpoint ${endpoint.origin}`);
} else {
  failures.push("LOCAL_LLM_BASE_URL must use an HTTP loopback address");
}

if (validEndpoint) {
  try {
    const response = await fetch(new URL("/api/tags", endpoint), {
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(5000)
    });
    const body = await response.json();
    const installed = (body.models || []).some(
      (candidate) =>
        candidate.name === model ||
        candidate.name?.split(":")[0] === model.split(":")[0]
    );
    if (installed) passes.push(`Ollama model ${model}`);
    else failures.push(`Ollama is reachable but model ${model} is not installed`);
  } catch {
    failures.push("Ollama is not reachable on the configured loopback endpoint");
  }
}

for (const asset of [
  "public/ocr/worker.min.js",
  "public/ocr/lang/eng.traineddata.gz"
]) {
  try {
    await access(path.join(process.cwd(), asset));
    passes.push(`Bundled OCR asset ${asset}`);
  } catch {
    failures.push(`Missing OCR asset ${asset}; run npm install`);
  }
}

try {
  const data = await stat(path.join(process.cwd(), ".verity-local-data"));
  const mode = data.mode & 0o777;
  if (mode === 0o700) passes.push("Local vault directory permission 0700");
  else failures.push(`Local vault directory permission is ${mode.toString(8)}, expected 700`);
} catch {
  passes.push("Local vault will be created with permission 0700 on first setup");
}

console.log("Local readiness checks");
for (const result of passes) console.log(`PASS  ${result}`);
for (const result of failures) console.log(`FAIL  ${result}`);

if (failures.length > 0) process.exitCode = 1;
