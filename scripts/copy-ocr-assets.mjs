import { copyFile, mkdir, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = join(projectRoot, "public", "ocr");
const coreSource = join(projectRoot, "node_modules", "tesseract.js-core");
const languageSources = ["eng", "spa"].map((language) => ({ language, source: join(projectRoot, "node_modules", "@tesseract.js-data", language, "4.0.0_best_int", `${language}.traineddata.gz`) }));

await rm(outputRoot, { recursive: true, force: true });
await mkdir(join(outputRoot, "core"), { recursive: true });
await mkdir(join(outputRoot, "lang"), { recursive: true });

await copyFile(
  join(projectRoot, "node_modules", "tesseract.js", "dist", "worker.min.js"),
  join(outputRoot, "worker.min.js")
);
await Promise.all(languageSources.map(({ language, source }) => copyFile(source, join(outputRoot, "lang", `${language}.traineddata.gz`))));
await copyFile(
  join(projectRoot, "node_modules", "pdfjs-dist", "legacy", "build", "pdf.worker.min.mjs"),
  join(outputRoot, "pdf.worker.min.mjs")
);

const coreFiles = (await readdir(coreSource)).filter((name) =>
  /^tesseract-core(?:-relaxedsimd|-simd)?-lstm\.wasm(?:\.js)?$/.test(name)
);
await Promise.all(
  coreFiles.map((name) =>
    copyFile(join(coreSource, name), join(outputRoot, "core", name))
  )
);

console.log(
  `Prepared self-hosted English/Spanish OCR and PDF assets: ${coreFiles.length + 4} files in public/ocr`
);
