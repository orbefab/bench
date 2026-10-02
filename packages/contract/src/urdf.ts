/**
 * Link names, joint names, and mesh filenames from URDF XML text.
 *
 * The contract has no DOM and no Node APIs, so this is a scan: comments
 * are dropped, then each `<link>`, `<joint>`, and `<mesh>` tag is read
 * for `name` and `filename`. Attribute values are XML-decoded. Paths are
 * returned as written. `package://` and absolute paths are not resolved
 * here; `resolveUrdfMesh` only joins a mesh filename onto the URDF's
 * directory.
 */

export type UrdfJointInfo = {
  name: string;
  /** URDF `type`. Empty when the attribute is missing. */
  type: string;
  parent: string;
  /** The link this joint moves. */
  child: string;
  axis: [number, number, number] | null;
  /** Radians from `<limit>`. Null when that attribute is absent. */
  lower: number | null;
  upper: number | null;
};

export type UrdfInfo = {
  links: string[];
  joints: string[];
  meshes: string[];
  /** Named joints, in document order. */
  jointInfo: UrdfJointInfo[];
  /** Every `<mesh>` filename under that link, in document order. */
  linkMeshes: Record<string, string[]>;
};

export function decodeXml(text: string): string {
  return text
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

export function attr(attrs: string, name: string): string | undefined {
  const match = new RegExp(
    `(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`
  ).exec(attrs);
  if (!match) return undefined;
  return decodeXml(match[1] ?? match[2] ?? "");
}

function finiteNum(text: string | undefined): number | null {
  if (text === undefined || text.trim() === "") return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

function axisOf(text: string | undefined): [number, number, number] | null {
  if (!text) return null;
  const parts = text
    .trim()
    .split(/\s+/)
    .map((part) => Number(part));
  if (parts.length < 3 || parts.slice(0, 3).some((n) => !Number.isFinite(n))) {
    return null;
  }
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}

function blankJoint(name: string, type: string): UrdfJointInfo {
  return {
    name,
    type,
    parent: "",
    child: "",
    axis: null,
    lower: null,
    upper: null,
  };
}

export function extractUrdfJointsAndMeshes(xml: string): UrdfInfo {
  const stripped = xml.replace(/<!--[\s\S]*?-->/g, "");
  const links: string[] = [];
  const joints: string[] = [];
  const meshes: string[] = [];
  const jointInfo: UrdfJointInfo[] = [];
  const linkMeshes: Record<string, string[]> = {};
  let link: string | null = null;
  let joint: UrdfJointInfo | null = null;

  for (const tag of stripped.matchAll(
    /<(\/)?([A-Za-z][\w:.-]*)\b([^>]*?)(\/)?>/g
  )) {
    const closing = Boolean(tag[1]);
    const element = tag[2] ?? "";
    const attrs = tag[3] ?? "";
    const selfClosing = Boolean(tag[4]);

    if (closing) {
      if (element === "link") link = null;
      if (element === "joint" && joint) {
        jointInfo.push(joint);
        joint = null;
      }
      continue;
    }

    if (element === "link") {
      const name = attr(attrs, "name");
      link = name ?? null;
      if (name) {
        links.push(name);
        if (!linkMeshes[name]) linkMeshes[name] = [];
      }
    } else if (element === "joint") {
      const name = attr(attrs, "name");
      if (name) {
        joints.push(name);
        joint = blankJoint(name, attr(attrs, "type") ?? "");
      } else {
        joint = null;
      }
    } else if (element === "parent" && joint) {
      joint.parent = attr(attrs, "link") ?? "";
    } else if (element === "child" && joint) {
      joint.child = attr(attrs, "link") ?? "";
    } else if (element === "axis" && joint) {
      joint.axis = axisOf(attr(attrs, "xyz"));
    } else if (element === "limit" && joint) {
      joint.lower = finiteNum(attr(attrs, "lower"));
      joint.upper = finiteNum(attr(attrs, "upper"));
    } else if (element === "mesh") {
      const filename = attr(attrs, "filename");
      if (filename !== undefined) {
        meshes.push(filename);
        if (link) {
          const list = linkMeshes[link] ?? [];
          list.push(filename);
          linkMeshes[link] = list;
        }
      }
    }

    if (selfClosing && element === "link") link = null;
    if (selfClosing && element === "joint" && joint) {
      jointInfo.push(joint);
      joint = null;
    }
  }

  if (joint) jointInfo.push(joint);
  return { links, joints, meshes, jointInfo, linkMeshes };
}

/**
 * A mesh filename joined onto the URDF's directory. Both inputs are
 * relative to the world file. `..` does not resolve; the caller rejects it.
 */
export function resolveUrdfMesh(
  urdfRel: string,
  mesh: string
): string | undefined {
  const slash = urdfRel.lastIndexOf("/");
  const dir = slash === -1 ? "" : urdfRel.slice(0, slash);
  const parts: string[] = [];
  for (const part of `${dir}/${mesh}`.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") return undefined;
    parts.push(part);
  }
  if (parts.length === 0) return undefined;
  return parts.join("/");
}
