import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

import {
  extractUrdfJointsAndMeshes,
  partDocumentProject,
  resolveUrdfMesh,
} from "@sfab-bench/contract";

import { planWorld } from "./plan";

/**
 * Same containment rule as `projects.insideRoot`. This file does not import
 * `projects`: the world worker loads it, and `projects` opens sqlite.
 */
function insideRoot(root: string, abs: string): boolean {
  const rel = relative(resolve(root), abs);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function projectReal(root: string): string | null {
  try {
    return realpathSync(root);
  } catch {
    return null;
  }
}

/** A project-relative file that stays inside `rootReal` after symlink resolution. */
export function resolveInside(rootReal: string, rel: string): string | null {
  const clean = rel.trim().replace(/\\/g, "/").replace(/^\/+/, "");
  if (!clean || clean.split("/").includes("..") || isAbsolute(clean)) {
    return null;
  }
  const abs = resolve(rootReal, clean);
  if (!existsSync(abs)) return null;
  let real: string;
  try {
    real = realpathSync(abs);
  } catch {
    return null;
  }
  if (!insideRoot(rootReal, real)) return null;
  if (!statSync(real).isFile()) return null;
  return real;
}

export function readInside(rootReal: string, rel: string): Uint8Array | null {
  const abs = resolveInside(rootReal, rel);
  if (!abs) return null;
  try {
    return new Uint8Array(readFileSync(abs));
  } catch {
    return null;
  }
}

export function parentRel(rel: string): string {
  const clean = rel.replace(/\\/g, "/");
  const slash = clean.lastIndexOf("/");
  return slash === -1 ? "" : clean.slice(0, slash);
}

/** Join two relative paths. `..` is rejected rather than normalised away. */
export function joinRel(dir: string, rel: string): string | null {
  const parts: string[] = [];
  for (const part of `${dir}/${rel}`.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") return null;
    parts.push(part);
  }
  if (parts.length === 0) return null;
  return parts.join("/");
}

/**
 * Bytes relative to the world file. The document's URDF and firmware paths
 * are written that way; mesh paths are relative to the URDF, and the model
 * builder joins those itself before asking.
 */
export type WorldBytes = {
  read(relativeToWorld: string): Uint8Array | null;
};

/**
 * Project directory for URDF and firmware paths. A root part lives
 * under `parts/<pub>/`; those paths stay relative to the project.
 */
export function documentAssetDir(rel: string): string {
  const clean = rel.replace(/\\/g, "/").replace(/^\/+/, "");
  const project = partDocumentProject(clean);
  if (project !== null) return project;
  return parentRel(clean);
}

/** Lock beside the document, not beside the project directory. */
export function documentLockRel(rel: string): string {
  const clean = rel.replace(/\\/g, "/").replace(/^\/+/, "");
  const slash = clean.lastIndexOf("/");
  const dir = slash === -1 ? "" : clean.slice(0, slash);
  const stem = pathBasename(clean);
  return dir ? `${dir}/${stem}.lock.json` : `${stem}.lock.json`;
}

export function readerFor(rootReal: string, worldRel: string): WorldBytes {
  const dir = documentAssetDir(worldRel);
  return {
    read(rel: string) {
      const full = joinRel(dir, rel);
      if (!full) return null;
      return readInside(rootReal, full);
    },
  };
}

export function fileStamp(abs: string): string {
  try {
    const st = statSync(abs);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return "missing";
  }
}

/**
 * Project-relative paths the run depends on: the world file, each URDF,
 * and each mesh filename resolved from that URDF. Firmware is a board
 * input and does not rebuild the physics.
 */
export function dependencyRels(rootReal: string, worldRel: string): string[] {
  const rels = [worldRel];
  const planned = planWorld(rootReal, worldRel);
  if (!planned.ok) return rels;
  const worldDir = documentAssetDir(worldRel);
  for (const robot of planned.plan.robots) {
    const urdfRel = joinRel(worldDir, robot.urdf);
    if (!urdfRel) continue;
    rels.push(urdfRel);
    const urdfAbs = resolveInside(rootReal, urdfRel);
    if (!urdfAbs) continue;
    let xml = "";
    try {
      xml = readFileSync(urdfAbs, "utf8");
    } catch {
      continue;
    }
    for (const mesh of extractUrdfJointsAndMeshes(xml).meshes) {
      const meshRel = resolveUrdfMesh(urdfRel, mesh);
      if (meshRel) rels.push(meshRel);
    }
  }
  const lockRel = documentLockRel(worldRel);
  if (lockRel && resolveInside(rootReal, lockRel)) rels.push(lockRel);
  for (const partRel of partRels(rootReal, worldDir)) rels.push(partRel);
  return rels;
}

function pathBasename(rel: string): string {
  const clean = rel.replace(/\\/g, "/");
  const slash = clean.lastIndexOf("/");
  const name = slash === -1 ? clean : clean.slice(slash + 1);
  return name.replace(/\.json$/, "");
}

/** Project part files under the world directory. A change rebuilds the run. */
function partRels(rootReal: string, worldDir: string): string[] {
  const dirRel = joinRel(worldDir, "parts");
  if (!dirRel) return [];
  const abs = resolve(rootReal, dirRel);
  if (!existsSync(abs)) return [];
  const out: string[] = [];
  const walk = (folder: string, prefix: string) => {
    let names: string[] = [];
    try {
      names = readdirSync(folder);
    } catch {
      return;
    }
    for (const name of names) {
      const child = join(folder, name);
      const rel = `${prefix}/${name}`;
      try {
        if (statSync(child).isDirectory()) walk(child, rel);
        else if (name.endsWith(".json")) out.push(rel);
      } catch {
        /* skip */
      }
    }
  };
  walk(abs, dirRel);
  return out;
}

export type FirmwareWatch = {
  id: string;
  /** Project-relative `.hex` path. */
  rel: string;
  stamp: string;
};

/** Board firmware images. A change restarts that board and not the physics. */
export function firmwareWatch(
  rootReal: string,
  worldRel: string
): FirmwareWatch[] {
  const planned = planWorld(rootReal, worldRel);
  if (!planned.ok) return [];
  const worldDir = documentAssetDir(worldRel);
  const out: FirmwareWatch[] = [];
  for (const board of planned.plan.boards) {
    const rel = joinRel(worldDir, board.firmware);
    if (!rel) continue;
    const abs = resolveInside(rootReal, rel);
    out.push({ id: board.id, rel, stamp: abs ? fileStamp(abs) : "missing" });
  }
  return out;
}

export function dependencyStamp(rootReal: string, rels: string[]): string {
  return rels
    .map((rel) => {
      const abs = resolveInside(rootReal, rel);
      return `${rel}=${abs ? fileStamp(abs) : "missing"}`;
    })
    .join("|");
}
