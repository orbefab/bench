/**
 * `/api/world/live?project=&world=`, plus `?token=` for a paired device.
 * The session socket uses the same scheme and token query: a WebSocket
 * cannot set Authorization.
 */
export function worldLiveSocketUrl(input: {
  pageProtocol: string;
  host: string;
  project: string;
  world: string;
  token: string | null;
}): string {
  const proto = input.pageProtocol === "https:" ? "wss:" : "ws:";
  const params = new URLSearchParams();
  params.set("project", input.project);
  params.set("world", input.world);
  if (input.token) params.set("token", input.token);
  return `${proto}//${input.host}/api/world/live?${params.toString()}`;
}
