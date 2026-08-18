import { access, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { loadEnvFile } from "node:process";

try {
  loadEnvFile(".env.local");
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

const minimumNode = [20, 18, 0];
const currentNode = process.versions.node.split(".").map(Number);
const provider = (process.env.LOCAL_LLM_PROVIDER?.trim().toLowerCase() || "ollama");
const defaultEndpoint = provider === "openai" ? "http://127.0.0.1:8000" : "http://127.0.0.1:11434";
const model = process.env.LOCAL_LLM_MODEL?.trim() || (provider === "openai" ? "Qwen3-8B-4bit" : "qwen3:8b");
const visualModel = process.env.LOCAL_VISION_MODEL?.trim() || (provider === "openai" ? "Qwen3-VL-8B-Instruct-4bit" : "qwen3-vl:8b");
const apiKey = process.env.LOCAL_LLM_API_KEY?.trim() || "";
const failures = [];
const passes = [];
let endpoint;
try {
  endpoint = new URL(
    process.env.LOCAL_LLM_BASE_URL || defaultEndpoint
  );
} catch {
  failures.push("LOCAL_LLM_BASE_URL must be a valid URL");
}

if (provider !== "ollama" && provider !== "openai") {
  failures.push('LOCAL_LLM_PROVIDER must be "ollama" or "openai"');
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

if (process.platform === "darwin") {
  try {
    await access("/usr/bin/security");
    passes.push("macOS Keychain credential store");
  } catch {
    failures.push("macOS Keychain command is unavailable");
  }
} else {
  failures.push("Local-first v1 passwordless vault currently requires macOS");
}

const validEndpoint = Boolean(endpoint) &&
  endpoint.protocol === "http:" &&
  ["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname);
if (validEndpoint) {
  passes.push(`Local model endpoint ${endpoint.origin}`);
} else {
  failures.push("LOCAL_LLM_BASE_URL must use an HTTP loopback address");
}

// Model identifiers are normalized the same way the application does, so a
// quantization suffix or vendor prefix does not read as "not installed".
function normalizeModelName(value) {
  const withoutVendor = value.includes("/") ? value.slice(value.lastIndexOf("/") + 1) : value;
  const [name, tag = "latest"] = withoutVendor.trim().split(":");
  return { name, tag };
}

function modelInstalled(installedNames, configured) {
  const target = normalizeModelName(configured);
  return installedNames.some((installed) => {
    const candidate = normalizeModelName(installed);
    return candidate.name === target.name
      && (candidate.tag === target.tag || candidate.tag.startsWith(`${target.tag}-`));
  });
}

if (validEndpoint) {
  const label = provider === "openai" ? "Local OpenAI-compatible server" : "Ollama";
  try {
    const response = await fetch(
      new URL(provider === "openai" ? "/v1/models" : "/api/tags", endpoint),
      {
        cache: "no-store",
        redirect: "error",
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
        signal: AbortSignal.timeout(5000)
      }
    );
    if (response.status === 401 || response.status === 403) {
      failures.push(`${label} rejected the API key; set LOCAL_LLM_API_KEY`);
    } else if (!response.ok) {
      failures.push(`${label} returned HTTP ${response.status} when listing models`);
    } else {
      const body = await response.json();
      const installedNames = provider === "openai"
        ? (body.data || []).map((candidate) => candidate.id).filter(Boolean)
        : (body.models || []).map((candidate) => candidate.name || candidate.model).filter(Boolean);
      if (modelInstalled(installedNames, model)) passes.push(`${label} text model ${model}`);
      else failures.push(`${label} is reachable but text model ${model} is not installed`);
      if (modelInstalled(installedNames, visualModel)) passes.push(`${label} visual model ${visualModel}`);
      else failures.push(`${label} is reachable but visual model ${visualModel} is not installed`);
    }
  } catch {
    failures.push(`${label} is not reachable on the configured loopback endpoint`);
  }
}

for (const asset of [
  "public/ocr/worker.min.js",
  "public/ocr/pdf.worker.min.mjs",
  "public/ocr/lang/eng.traineddata.gz",
  "public/ocr/lang/spa.traineddata.gz"
]) {
  try {
    await access(path.join(process.cwd(), asset));
    passes.push(`Bundled OCR asset ${asset}`);
  } catch {
    failures.push(`Missing OCR asset ${asset}; run npm install`);
  }
}

const paddlePython = process.env.PADDLEOCR_PYTHON;
const paddleModelDir = process.env.PADDLE_OCR_MODEL_DIR;
if (!paddlePython || !path.isAbsolute(paddlePython)) failures.push("PADDLEOCR_PYTHON must be an absolute path to the offline PaddleOCR Python environment");
else { try { await access(paddlePython); passes.push(`PaddleOCR Python ${paddlePython}`); } catch { failures.push(`PaddleOCR Python is missing: ${paddlePython}`); } }
if (!paddleModelDir || !path.isAbsolute(paddleModelDir)) failures.push("PADDLE_OCR_MODEL_DIR must be an absolute path to downloaded PP-OCRv5 weights");
else for (const directory of ["detection", "recognition"]) { try { await access(path.join(paddleModelDir, directory)); passes.push(`PP-OCRv5 local ${directory} weights`); } catch { failures.push(`Missing PP-OCRv5 ${directory} weights in ${paddleModelDir}`); } }

const configuredDataRoot = process.env.LOCAL_DATA_DIRECTORY?.trim();
if (configuredDataRoot && !path.isAbsolute(configuredDataRoot)) {
  failures.push("LOCAL_DATA_DIRECTORY must be an absolute path");
}
const dataRoot = configuredDataRoot || path.join(homedir(), ".verity-caseworks");
const profile = process.env.LOCAL_DATA_PROFILE?.trim();
const dataDirectory = profile ? path.join(dataRoot, "profiles", profile) : path.join(dataRoot, "data");
try {
  const data = await stat(dataDirectory);
  const mode = data.mode & 0o777;
  if (mode === 0o700) passes.push(`Local vault directory permission 0700 (${dataDirectory})`);
  else failures.push(`Local vault directory permission is ${mode.toString(8)}, expected 700`);
} catch {
  passes.push(`Local vault will be created with permission 0700 at ${dataDirectory}`);
}

console.log("Local readiness checks");
for (const result of passes) console.log(`PASS  ${result}`);
for (const result of failures) console.log(`FAIL  ${result}`);

if (failures.length > 0) process.exitCode = 1;
