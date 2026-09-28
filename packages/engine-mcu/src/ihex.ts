/** ATmega328P flash, in bytes. avr8js addresses it as 16-bit words. */
export const FLASH_BYTES = 32 * 1024;

export type IntelHex =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; error: string };

/**
 * Intel HEX into a 32 KiB image. Unprogrammed bytes stay 0xFF (erased
 * flash). A bad checksum or an address outside the flash is an error.
 */
export function parseIntelHex(source: string): IntelHex {
  const bytes = new Uint8Array(FLASH_BYTES);
  bytes.fill(0xff);
  let base = 0;
  let sawData = false;
  const lines = source.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]?.trim() ?? "";
    if (!line) continue;
    const where = `line ${index + 1}`;
    if (!line.startsWith(":")) {
      return { ok: false, error: `${where} is not an Intel HEX record` };
    }
    const body = line.slice(1);
    if (body.length < 10 || body.length % 2 !== 0) {
      return { ok: false, error: `${where} is truncated` };
    }
    const raw = new Uint8Array(body.length / 2);
    for (let i = 0; i < raw.length; i++) {
      const hex = body.slice(i * 2, i * 2 + 2);
      const value = Number.parseInt(hex, 16);
      if (!/^[0-9a-fA-F]{2}$/.test(hex) || !Number.isFinite(value)) {
        return { ok: false, error: `${where} has a non-hex byte` };
      }
      raw[i] = value;
    }
    const count = raw[0] ?? 0;
    const addr = ((raw[1] ?? 0) << 8) | (raw[2] ?? 0);
    const type = raw[3] ?? 0;
    if (raw.length !== count + 5) {
      return {
        ok: false,
        error: `${where} length does not match its byte count`,
      };
    }
    let sum = 0;
    for (const byte of raw) sum = (sum + byte) & 0xff;
    if (sum !== 0) {
      return { ok: false, error: `${where} has a bad checksum` };
    }
    const data = raw.subarray(4, 4 + count);
    if (type === 0x00) {
      const start = (base + addr) >>> 0;
      if (count > 0 && (start > FLASH_BYTES || start + count > FLASH_BYTES)) {
        return {
          ok: false,
          error: `${where} writes past the end of flash (0x${start.toString(16)})`,
        };
      }
      if (count > 0) {
        bytes.set(data, start);
        sawData = true;
      }
    } else if (type === 0x01) {
      /* end of file */
    } else if (type === 0x02) {
      if (count !== 2) {
        return {
          ok: false,
          error: `${where} extended segment address is malformed`,
        };
      }
      base = (((data[0] ?? 0) << 8) | (data[1] ?? 0)) << 4;
    } else if (type === 0x04) {
      if (count !== 2) {
        return {
          ok: false,
          error: `${where} extended linear address is malformed`,
        };
      }
      base = ((((data[0] ?? 0) << 8) | (data[1] ?? 0)) << 16) >>> 0;
    } else if (type === 0x03 || type === 0x05) {
      /* start address. The reset vector is in the image. */
    } else {
      return {
        ok: false,
        error: `${where} has an unknown record type ${type}`,
      };
    }
  }
  if (!sawData) return { ok: false, error: "firmware image has no data" };
  return { ok: true, bytes };
}
