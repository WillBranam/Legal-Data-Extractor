import { copyFile, mkdir, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = join(projectRoot, "public", "ocr");
const coreSource = join(projectRoot, "node_modules", "tesseract.js-core");
const languageSource = join(
  projectRoot,
  "node_modules",
  "@tesseract.js-data",
  "eng",
  "4.0.0_best_int",
  "eng.traineddata.gz"
);

await rm(outputRoot, { recursive: true, force: true });
await mkdir(join(outputRoot, "core"), { recursive: true });
await mkdir(join(outputRoot, "lang"), { recursive: true });

await copyFile(
  join(projectRoot, "node_modules", "tesseract.js", "dist", "worker.min.js"),
  join(outputRoot, "worker.min.js")
);
await copyFile(languageSource, join(outputRoot, "lang", "eng.traineddata.gz"));

const coreFiles = (await readdir(coreSource)).filter((name) =>
  /^tesseract-core(?:-relaxedsimd|-simd)?-lstm\.wasm(?:\.js)?$/.test(name)
);
await Promise.all(
  coreFiles.map((name) =>
    copyFile(join(coreSource, name), join(outputRoot, "core", name))
  )
);

console.log(
  `Prepared self-hosted OCR assets: ${coreFiles.length + 2} files in public/ocr`
);
