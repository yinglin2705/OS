/** Compare the browser Origin with the public Host, not Next.js's internal bind address. */
export function sameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return false;
  try {
    const source = new URL(origin);
    const host = req.headers.get("host") || new URL(req.url).host;
    const forwardedProto = req.headers.get("x-forwarded-proto");
    const protocol =
      forwardedProto === "https" || forwardedProto === "http"
        ? `${forwardedProto}:`
        : new URL(req.url).protocol;
    return (
      ["https:", "http:"].includes(source.protocol) &&
      source.host === host &&
      source.protocol === protocol
    );
  } catch {
    return false;
  }
}
