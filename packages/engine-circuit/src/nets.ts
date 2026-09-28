// Ported from layered-sim E3 src/nets.ts @ fc7e8d3. Roles only; the loader owns the richer pass.
/** Electrical port role. Matches the part-type vocabulary. */
export type PortRole = "power" | "ground" | "logic" | "analog";

export type NetLevel = "digital" | "analog";

/**
 * A net is digital when every port is logic. Ground, power and analog
 * force analog. `force` is a world rule and wins either way (D-006).
 */
export function classifyNet(
  roles: readonly PortRole[],
  force?: NetLevel
): NetLevel {
  if (force === "digital" || force === "analog") return force;
  for (let i = 0; i < roles.length; i++) {
    if (roles[i] !== "logic") return "analog";
  }
  return "digital";
}
