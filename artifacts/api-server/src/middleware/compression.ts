import type { Request, Response, NextFunction } from "express";
import zlib from "node:zlib";

// Below this, the gzip header + CPU costs more than the bytes saved.
const MIN_COMPRESS_BYTES = 1024;

// Level 6 is zlib's default and the usual sweet spot; on JSON the jump to 9 buys
// ~1-2% more compression for roughly double the CPU, which is the wrong trade when
// CPU time is what the server bill is measured in.
const GZIP_OPTIONS: zlib.ZlibOptions = { level: 6 };
const BROTLI_OPTIONS = {
  params: {
    [zlib.constants.BROTLI_PARAM_QUALITY]: 4,
    [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT,
  },
};

function pickEncoding(header: string | undefined): "br" | "gzip" | null {
  if (!header) return null;
  const accepted = header.toLowerCase();
  // Brotli beats gzip by ~15-20% on JSON at comparable CPU for quality <= 4.
  if (accepted.includes("br")) return "br";
  if (accepted.includes("gzip")) return "gzip";
  return null;
}

/**
 * Compresses JSON/text responses in-process, with no added dependency (node:zlib).
 *
 * API responses here are highly repetitive JSON — long key names repeated across every
 * row of a list — which is close to the best case for a dictionary coder: typical list
 * payloads shrink by 85-95%. Egress is billed per byte on every managed host, and it is
 * the single largest controllable line item for a read-heavy API like this one, so this
 * is the cheapest large saving available.
 *
 * Wraps res.json/res.send rather than the write stream: every route in this codebase
 * replies through one of those two, so buffering is already happening and there is no
 * streaming behaviour to preserve.
 */
export function compressionMiddleware(req: Request, res: Response, next: NextFunction) {
  const encoding = pickEncoding(req.headers["accept-encoding"] as string | undefined);
  if (!encoding) return next();

  const originalJson = res.json.bind(res);
  const originalSend = res.send.bind(res);
  let compressing = false;

  const compress = (body: string, contentType: string) => {
    const raw = Buffer.from(body, "utf8");
    if (raw.byteLength < MIN_COMPRESS_BYTES) {
      res.setHeader("Content-Type", contentType);
      return originalSend(body);
    }
    let packed: Buffer;
    try {
      packed = encoding === "br"
        ? zlib.brotliCompressSync(raw, BROTLI_OPTIONS)
        : zlib.gzipSync(raw, GZIP_OPTIONS);
    } catch {
      // Never fail a response because compression failed — send it uncompressed.
      res.setHeader("Content-Type", contentType);
      return originalSend(body);
    }
    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Encoding", encoding);
    res.setHeader("Content-Length", String(packed.byteLength));
    // Caches keyed on the URL alone must not hand a gzipped body to a client that
    // asked for none.
    res.setHeader("Vary", "Accept-Encoding");
    return originalSend(packed);
  };

  res.json = ((body: unknown) => {
    if (compressing) return originalJson(body);
    compressing = true;
    return compress(JSON.stringify(body), "application/json; charset=utf-8");
  }) as typeof res.json;

  res.send = ((body: unknown) => {
    if (compressing || typeof body !== "string") return originalSend(body as never);
    compressing = true;
    return compress(body, res.getHeader("Content-Type")?.toString() ?? "text/html; charset=utf-8");
  }) as typeof res.send;

  next();
}
