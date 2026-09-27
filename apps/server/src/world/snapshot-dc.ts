/** DC of a stamped assembly. Feed kind stays here so capture stays device-free. */

import type { BoardStamp } from "./circuit-stamp";
import { branchDc, netlistDc } from "./nano-usb-dc";

export { branchDc };

export type FeedKind = "usb" | "header";

export function feedKind(onConnector: boolean): FeedKind {
  return onConnector ? "usb" : "header";
}

export function supplyDc(
  stamp: BoardStamp,
  supply: number,
  amps: number,
  rSeries: number,
  onConnector: boolean,
  loadPort: string
): number {
  return netlistDc(
    stamp,
    supply,
    amps,
    rSeries,
    feedKind(onConnector),
    loadPort
  );
}
