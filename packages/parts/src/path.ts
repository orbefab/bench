/**
 * POSIX paths, the same results as `node:path` on macOS and Linux.
 * The loader joins, takes a parent, a base name, a relative path, and
 * resolves a file against an asset root. No `node:*` import.
 */

const SLASH = 47;
const DOT = 46;

function cwd(): string {
  const proc = (globalThis as { process?: { cwd?: () => string } }).process;
  const dir = proc?.cwd?.();
  return dir && dir.length > 0 ? dir : "/";
}

function normalizeString(path: string, allowAboveRoot: boolean): string {
  let res = "";
  let lastSegmentLength = 0;
  let lastSlash = -1;
  let dots = 0;
  let code = 0;
  for (let i = 0; i <= path.length; ++i) {
    if (i < path.length) code = path.charCodeAt(i);
    else if (code === SLASH) break;
    else code = SLASH;
    if (code === SLASH) {
      if (lastSlash === i - 1 || dots === 1) {
        // skip
      } else if (dots === 2) {
        if (
          res.length < 2 ||
          lastSegmentLength !== 2 ||
          res.charCodeAt(res.length - 1) !== DOT ||
          res.charCodeAt(res.length - 2) !== DOT
        ) {
          if (res.length > 2) {
            const lastSlashIndex = res.lastIndexOf("/");
            if (lastSlashIndex !== res.length - 1) {
              if (lastSlashIndex === -1) {
                res = "";
                lastSegmentLength = 0;
              } else {
                res = res.slice(0, lastSlashIndex);
                lastSegmentLength = res.length - 1 - res.lastIndexOf("/");
              }
              lastSlash = i;
              dots = 0;
              continue;
            }
          } else if (res.length === 2 || res.length === 1) {
            res = "";
            lastSegmentLength = 0;
            lastSlash = i;
            dots = 0;
            continue;
          }
        }
        if (allowAboveRoot) {
          res = res.length > 0 ? `${res}/..` : "..";
          lastSegmentLength = 2;
        }
      } else {
        const segment = path.slice(lastSlash + 1, i);
        res = res.length > 0 ? `${res}/${segment}` : segment;
        lastSegmentLength = i - lastSlash - 1;
      }
      lastSlash = i;
      dots = 0;
    } else if (code === DOT && dots !== -1) {
      ++dots;
    } else {
      dots = -1;
    }
  }
  return res;
}

export function normalize(path: string): string {
  if (path.length === 0) return ".";
  const isAbsolute = path.charCodeAt(0) === SLASH;
  const trailing = path.charCodeAt(path.length - 1) === SLASH;
  let out = normalizeString(path, !isAbsolute);
  if (out.length === 0 && !isAbsolute) out = ".";
  if (out.length > 0 && trailing) out += "/";
  return isAbsolute ? `/${out}` : out;
}

export function join(...parts: string[]): string {
  if (parts.length === 0) return ".";
  let joined: string | undefined;
  for (const part of parts) {
    if (part.length === 0) continue;
    joined = joined === undefined ? part : `${joined}/${part}`;
  }
  return joined === undefined ? "." : normalize(joined);
}

export function dirname(path: string): string {
  if (path.length === 0) return ".";
  const hasRoot = path.charCodeAt(0) === SLASH;
  let end = -1;
  let matchedSlash = true;
  for (let i = path.length - 1; i >= 1; --i) {
    if (path.charCodeAt(i) === SLASH) {
      if (!matchedSlash) {
        end = i;
        break;
      }
    } else {
      matchedSlash = false;
    }
  }
  if (end === -1) return hasRoot ? "/" : ".";
  if (hasRoot && end === 1) return "//";
  return path.slice(0, end);
}

export function basename(path: string): string {
  let start = 0;
  let end = -1;
  let matchedSlash = true;
  for (let i = path.length - 1; i >= 0; --i) {
    if (path.charCodeAt(i) === SLASH) {
      if (!matchedSlash) {
        start = i + 1;
        break;
      }
    } else if (end === -1) {
      matchedSlash = false;
      end = i + 1;
    }
  }
  if (end === -1) return "";
  return path.slice(start, end);
}

export function resolve(...parts: string[]): string {
  let resolvedPath = "";
  let resolvedAbsolute = false;
  for (let i = parts.length - 1; i >= -1 && !resolvedAbsolute; i--) {
    const path = i >= 0 ? parts[i] : cwd();
    if (!path || path.length === 0) continue;
    resolvedPath = `${path}/${resolvedPath}`;
    resolvedAbsolute = path.charCodeAt(0) === SLASH;
  }
  resolvedPath = normalizeString(resolvedPath, !resolvedAbsolute);
  if (resolvedAbsolute)
    return resolvedPath.length > 0 ? `/${resolvedPath}` : "/";
  return resolvedPath.length > 0 ? resolvedPath : ".";
}

export function relative(from: string, to: string): string {
  if (from === to) return "";
  const fromAbs = resolve(from);
  const toAbs = resolve(to);
  if (fromAbs === toAbs) return "";
  const fromStart = 1;
  const toStart0 = 1;
  const fromLen = fromAbs.length - fromStart;
  const toLen = toAbs.length - toStart0;
  const length = fromLen < toLen ? fromLen : toLen;
  let lastCommonSep = -1;
  let i = 0;
  for (; i <= length; ++i) {
    if (i === length) {
      if (toLen > length) {
        if (toAbs.charCodeAt(toStart0 + i) === SLASH) {
          return toAbs.slice(toStart0 + i + 1);
        }
        if (i === 0) return toAbs.slice(toStart0 + i);
      } else if (fromLen > length) {
        if (fromAbs.charCodeAt(fromStart + i) === SLASH) lastCommonSep = i;
        else if (i === 0) lastCommonSep = 0;
      }
      break;
    }
    const fromCode = fromAbs.charCodeAt(fromStart + i);
    const toCode = toAbs.charCodeAt(toStart0 + i);
    if (fromCode !== toCode) break;
    if (fromCode === SLASH) lastCommonSep = i;
  }
  let out = "";
  for (i = fromStart + lastCommonSep + 1; i <= fromAbs.length; ++i) {
    if (i === fromAbs.length || fromAbs.charCodeAt(i) === SLASH) {
      out = out.length === 0 ? ".." : `${out}/..`;
    }
  }
  if (out.length > 0) return out + toAbs.slice(toStart0 + lastCommonSep);
  let toStart = toStart0 + lastCommonSep;
  if (toAbs.charCodeAt(toStart) === SLASH) ++toStart;
  return toAbs.slice(toStart);
}

export const sep = "/";
