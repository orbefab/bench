/**
 * Identity of the world socket.
 *
 * A forced reopen bumps `loadId` and must attach again, because a doc
 * that failed validation does not keep streaming. `revision` is not an
 * argument: `reloaded` only refetches meshes on the socket already open.
 */
export function worldSocketKey(input: {
  project: string;
  world: string;
  loadId: number;
}): string {
  return `${input.project}\0${input.world}\0${input.loadId}`;
}
