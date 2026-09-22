// Minecraft Server List Ping over Cloudflare Workers TCP sockets.
// Same protocol as the Go API's mcping.go: handshake (next state = status),
// status request, read one framed status response, parse version.name.

import { connect } from "cloudflare:sockets";

function varInt(value) {
  const out = [];
  let v = value >>> 0;
  do {
    let b = v & 0x7f;
    v >>>= 7;
    if (v !== 0) b |= 0x80;
    out.push(b);
  } while (v !== 0);
  return out;
}

function mcString(s) {
  const bytes = new TextEncoder().encode(s);
  return [...varInt(bytes.length), ...bytes];
}

function frame(packet) {
  return Uint8Array.from([...varInt(packet.length), ...packet]);
}

// Reads a varint from buf at pos; returns [value, nextPos] or null if incomplete.
function readVarInt(buf, pos) {
  let value = 0, shift = 0;
  for (let i = 0; i < 5; i++) {
    if (pos >= buf.length) return null;
    const b = buf[pos++];
    value |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) return [value, pos];
    shift += 7;
  }
  throw new Error("varint too long");
}

export class PingError extends Error {
  constructor(message, { unreachableFromWorkers = false } = {}) {
    super(message);
    this.unreachableFromWorkers = unreachableFromWorkers;
  }
}

/**
 * Pings host:port. Resolves { versionName } or throws PingError.
 * `unreachableFromWorkers` is set when Cloudflare itself refuses the
 * connection (Workers can't open sockets to some addresses, e.g. other
 * Cloudflare-hosted IPs). That means "can't check", not "offline".
 */
export async function mcPing(host, port = 25565, timeoutMs = 4000) {
  let socket;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new PingError(`no answer from ${host}:${port} within ${timeoutMs}ms`)), timeoutMs);
  });

  const run = async () => {
    socket = connect({ hostname: host, port });
    const writer = socket.writable.getWriter();
    const handshake = [...varInt(0x00), ...varInt(763), ...mcString(host), (port >> 8) & 0xff, port & 0xff, ...varInt(1)];
    await writer.write(frame(handshake));
    await writer.write(frame(varInt(0x00)));

    const reader = socket.readable.getReader();
    let buf = new Uint8Array(0);
    for (;;) {
      const { value, done } = await reader.read();
      if (done) throw new PingError("connection closed before a status response");
      const next = new Uint8Array(buf.length + value.length);
      next.set(buf);
      next.set(value, buf.length);
      buf = next;
      if (buf.length > 1 << 20) throw new PingError("status response too large");

      const len = readVarInt(buf, 0);
      if (!len) continue;
      const [packetLen, bodyStart] = len;
      if (buf.length < bodyStart + packetLen) continue;

      const body = buf.subarray(bodyStart, bodyStart + packetLen);
      const id = readVarInt(body, 0);
      if (!id || id[0] !== 0x00) throw new PingError("not a Minecraft status response");
      const strLen = readVarInt(body, id[1]);
      if (!strLen) throw new PingError("malformed status response");
      const json = new TextDecoder().decode(body.subarray(strLen[1], strLen[1] + strLen[0]));
      let versionName = "";
      try { versionName = JSON.parse(json)?.version?.name || ""; } catch { /* odd forks: still a Minecraft reply */ }
      return { versionName };
    }
  };

  try {
    return await Promise.race([run(), timeout]);
  } catch (err) {
    if (err instanceof PingError) throw err;
    const msg = String(err?.message || err);
    const blocked = /cannot connect to the specified address|proxy request failed|connections to .* are not allowed/i.test(msg);
    throw new PingError(msg, { unreachableFromWorkers: blocked });
  } finally {
    clearTimeout(timer);
    // Don't await: closing a socket that never finished connecting can
    // itself hang, which would turn a 4s timeout into a stuck request.
    try { socket?.close().catch(() => {}); } catch { /* already closed */ }
  }
}
