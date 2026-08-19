import { access, chmod, cp, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

const profile = process.env.LOCAL_DATA_PROFILE?.trim();
if (profile && !/^[a-z0-9-]{1,40}$/i.test(profile)) {
  throw new Error("LOCAL_DATA_PROFILE must contain only letters, numbers, and hyphens");
}

const configuredRoot = process.env.LOCAL_DATA_DIRECTORY?.trim();
if (configuredRoot && !path.isAbsolute(configuredRoot)) {
  throw new Error("LOCAL_DATA_DIRECTORY must be an absolute path");
}

const root = configuredRoot || path.join(homedir(), ".verity-caseworks");
const destination = profile ? path.join(root, "profiles", profile) : path.join(root, "data");
const legacy = path.join(process.cwd(), profile ? `.verity-local-data-${profile}` : ".verity-local-data");

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

if (!(await exists(destination)) && await exists(legacy)) {
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  await cp(legacy, destination, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true });
  await chmod(destination, 0o700);
  console.log(`Copied the encrypted legacy vault to ${destination}. The original was preserved.`);
}
