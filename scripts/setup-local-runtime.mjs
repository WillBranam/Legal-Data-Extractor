#!/usr/bin/env node

import { spawn, execFile as nodeExecFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  access,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(nodeExecFile);
const projectRoot = process.cwd();
const runtimeRoot = path.join(homedir(), ".verity-caseworks", "runtime");
const environmentPath = path.join(runtimeRoot, "paddleocr-venv");
const pythonPath = path.join(environmentPath, "bin", "python");
const modelRoot = path.join(runtimeRoot, "ppocr-models-mobile");
const visionModel = process.env.LOCAL_VISION_MODEL?.trim() || "qwen3-vl:8b";
const ollamaUrl = "http://127.0.0.1:11434";
const paddleIndex = "https://www.paddlepaddle.org.cn/packages/stable/cpu/";
const models = [
  {
    target: "detection",
    extracted: "PP-OCRv5_mobile_det_infer",
    url: "https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0/PP-OCRv5_mobile_det_infer.tar"
  },
  {
    target: "recognition",
    extracted: "PP-OCRv5_mobile_rec_infer",
    url: "https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0/PP-OCRv5_mobile_rec_infer.tar"
  }
];

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: projectRoot,
      env: process.env,
      stdio: "inherit",
      ...options
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} failed (${signal || code})`));
    });
  });
}

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function commandAvailable(command) {
  try {
    await execFile("/usr/bin/which", [command], { maxBuffer: 4096 });
    return true;
  } catch {
    return false;
  }
}

async function ollamaReachable() {
  try {
    const response = await fetch(`${ollamaUrl}/api/tags`, {
      signal: AbortSignal.timeout(1500),
      redirect: "error"
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForOllama() {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (await ollamaReachable()) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("The temporary local Ollama server did not become ready.");
}

async function prepareOllama() {
  if (!(await commandAvailable("ollama"))) {
    throw new Error("Ollama is not installed. Install it before running local:setup.");
  }
  let ownedServer = null;
  if (!(await ollamaReachable())) {
    console.log("Starting a temporary loopback-only Ollama server...");
    ownedServer = spawn("ollama", ["serve"], {
      cwd: projectRoot,
      env: {
        ...process.env,
        OLLAMA_HOST: "127.0.0.1:11434",
        OLLAMA_NO_CLOUD: "1"
      },
      stdio: ["ignore", "ignore", "inherit"]
    });
    await waitForOllama();
  }
  console.log(`Installing local visual model ${visionModel}...`);
  await run("ollama", ["pull", visionModel], {
    env: {
      ...process.env,
      OLLAMA_HOST: ollamaUrl,
      OLLAMA_NO_CLOUD: "1"
    }
  });
  return ownedServer;
}

async function preparePython() {
  if (!(await commandAvailable("uv"))) {
    throw new Error("uv is required to create the isolated PaddleOCR environment.");
  }
  if (!(await exists(pythonPath))) {
    console.log(`Creating isolated Python environment at ${environmentPath}...`);
    await mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
    await run("uv", ["venv", "--python", "3.13", "--seed", environmentPath]);
  }
  console.log("Installing the macOS CPU inference engine...");
  await run("uv", [
    "pip", "install", "--python", pythonPath,
    "--index", paddleIndex,
    "paddlepaddle==3.3.0"
  ]);
  console.log("Installing PaddleOCR...");
  await run("uv", [
    "pip", "install", "--python", pythonPath,
    "paddleocr==3.3.2"
  ]);
  await execFile(pythonPath, [
    "-c",
    "import paddle, paddleocr; print('PaddleOCR Python environment ready')"
  ], { maxBuffer: 4096 });
}

async function installModel(model) {
  const target = path.join(modelRoot, model.target);
  if (await exists(path.join(target, "inference.json"))) {
    console.log(`PP-OCRv5 ${model.target} weights already present.`);
    return;
  }
  const token = randomBytes(6).toString("hex");
  const downloadDirectory = path.join(runtimeRoot, `.ppocr-download-${token}`);
  const archivePath = path.join(downloadDirectory, `${model.extracted}.tar`);
  const extractionDirectory = path.join(downloadDirectory, "extracted");
  await mkdir(extractionDirectory, { recursive: true, mode: 0o700 });
  try {
    console.log(`Downloading PP-OCRv5 ${model.target} weights...`);
    await run("curl", ["-fL", "--retry", "3", "--progress-bar", "-o", archivePath, model.url]);
    await run("tar", ["-xf", archivePath, "-C", extractionDirectory]);
    const extracted = path.join(extractionDirectory, model.extracted);
    if (!(await exists(path.join(extracted, "inference.json")))) {
      const contents = await readdir(extractionDirectory);
      throw new Error(`Unexpected ${model.target} model archive contents: ${contents.join(", ")}`);
    }
    await mkdir(modelRoot, { recursive: true, mode: 0o700 });
    if (await exists(target)) {
      await rename(target, `${target}.incomplete-${token}`);
    }
    await rename(extracted, target);
  } finally {
    await rm(downloadDirectory, { recursive: true, force: true });
  }
}

async function updateEnvironment() {
  const environmentFile = path.join(projectRoot, ".env.local");
  let text = "";
  try {
    text = await readFile(environmentFile, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const values = {
    PADDLEOCR_PYTHON: pythonPath,
    PADDLE_OCR_MODEL_DIR: modelRoot,
    LOCAL_VISION_MODEL: visionModel
  };
  for (const [key, value] of Object.entries(values)) {
    const line = `${key}=${value}`;
    const matcher = new RegExp(`^${key}=.*$`, "m");
    text = matcher.test(text)
      ? text.replace(matcher, line)
      : `${text.trimEnd()}${text.trim() ? "\n" : ""}${line}\n`;
  }
  await writeFile(environmentFile, text, { encoding: "utf8", mode: 0o600 });
  console.log("Updated .env.local with absolute local OCR paths.");
}

async function verifyOcr() {
  const fixture = path.join(
    projectRoot,
    "sample-data",
    "rivera-v-northstar",
    "06_investigator_field_note_scan.png"
  );
  if (!(await exists(fixture))) return;
  console.log("Running an offline OCR smoke test...");
  const result = await execFile(
    pythonPath,
    [path.join(projectRoot, "scripts", "ppocr-worker.py"), fixture, "--model-dir", modelRoot],
    {
      timeout: 180_000,
      maxBuffer: 16 * 1024 * 1024,
      env: {
        PATH: process.env.PATH || "",
        PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK: "True",
        PYTHONNOUSERSITE: "1"
      }
    }
  );
  const payload = JSON.parse(result.stdout.trim().split("\n").at(-1) || "{}");
  if (payload.engine !== "pp-ocrv5" || typeof payload.text !== "string") {
    throw new Error("PP-OCRv5 smoke test did not return a valid result.");
  }
  console.log(`PASS  PP-OCRv5 smoke test (${Math.round((payload.confidence || 0) * 100)}% mean confidence)`);
}

async function main() {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error("This setup command currently targets the supported Apple Silicon local appliance.");
  }
  await mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
  let ownedOllama = null;
  try {
    ownedOllama = await prepareOllama();
    await preparePython();
    for (const model of models) await installModel(model);
    await updateEnvironment();
    await verifyOcr();
    console.log("Running complete local readiness checks...");
    await run(process.execPath, [path.join(projectRoot, "scripts", "check-local-readiness.mjs")], {
      env: {
        ...process.env,
        OLLAMA_HOST: ollamaUrl
      }
    });
    console.log("\nLocal runtime setup complete. Start with: npm run local:model");
  } finally {
    if (ownedOllama && !ownedOllama.killed) ownedOllama.kill("SIGTERM");
  }
}

main().catch((error) => {
  console.error(`Local setup failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
