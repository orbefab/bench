/**
 * The server words an edit refusal as `<part> port <p> quantity <q>: <detail>
 * (<left> vs <right>)`. For the two Wire refusals the detail is already the
 * whole sentence, so the edit line shows only that. Every other message is
 * shown as the server sent it.
 */
const WIRE_REFUSAL =
  /^.* port \S+ quantity Port: (\S+ cannot be wired to itself|\S+ is \S+ and \S+ is \S+; a wire joins ports of one domain) \(.*\)$/s;

export function editMessageText(message: string): string {
  return WIRE_REFUSAL.exec(message)?.[1] ?? message;
}
