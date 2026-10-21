import { analyseJD, phraseIn } from "./engine.ts";
export const API_HOST = "boards-api.greenhouse.io";
export const AGENT = "YINGOSCareer/1.0";
export function boardURL(token: string, provider: "greenhouse" | "lever" = "greenhouse") {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(token))
    throw Error("Invalid board identifier");
  return provider === "lever"
    ? `https://api.lever.co/v0/postings/${token}?mode=json`
    : `https://${API_HOST}/v1/boards/${token}/jobs?content=true`;
}
export function sqlLiteral(value: string) {
  return "'" + value.replace(/'/g, "''") + "'";
}
export function htmlText(input: string) {
  const decoded = input
    .replace(/&#(x[0-9a-f]+|\d+);/gi, (_, s: string) => {
      const n =
        s[0].toLowerCase() === "x" ? parseInt(s.slice(1), 16) : Number(s);
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : " ";
    })
    .replace(
      /&(lt|gt|amp|quot|apos|nbsp);/g,
      (_, s: string) =>
        ({ lt: "<", gt: ">", amp: "&", quot: '"', apos: "'", nbsp: " " })[s] ||
        " ",
    );
  return decoded
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<\/(?:p|li|div|h[1-6])\s*>|<br\s*\/?>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n/g, "\n")
    .trim();
}
// Longest applicable rule wins; equal-length Allow wins. Explicit agent groups
// take precedence over '*'. Unknown or unreachable robots is handled by caller.
export function robotsAllows(text: string, path: string) {
  const groups: {
    agents: string[];
    rules: { allow: boolean; path: string }[];
  }[] = [];
  let group: {
    agents: string[];
    rules: { allow: boolean; path: string }[];
  } | null = null;
  for (const original of text.split(/\r?\n/)) {
    const line = original.split("#")[0].trim();
    const m = line.match(/^([^:]+):\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase(),
      value = m[2].trim();
    if (key === "user-agent") {
      if (!group || group.rules.length) {
        group = { agents: [], rules: [] };
        groups.push(group);
      }
      group.agents.push(value.toLowerCase());
    } else if (group && (key === "allow" || key === "disallow") && value)
      group.rules.push({ allow: key === "allow", path: value });
  }
  const specific = groups.filter((g) =>
    g.agents.some((a) => a !== "*" && AGENT.toLowerCase().startsWith(a)),
  );
  const selected = specific.length
    ? specific
    : groups.filter((g) => g.agents.includes("*"));
  const rules = selected
    .flatMap((g) => g.rules)
    .filter((r) => {
      const exact = r.path.endsWith("$");
      const pattern = r.path
        .replace(/\$$/, "")
        .split("*")
        .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join(".*");
      return new RegExp("^" + pattern + (exact ? "$" : "")).test(path);
    })
    .sort(
      (a, b) =>
        b.path.length - a.path.length || Number(b.allow) - Number(a.allow),
    );
  return !rules.length || rules[0].allow;
}
export async function boundedFetch(
  url: string,
  maxBytes: number,
  fetcher: typeof fetch = fetch,
) {
  const parsed = new URL(url);
  if (
    parsed.protocol !== "https:" ||
    ![API_HOST, "api.lever.co"].includes(parsed.hostname) ||
    parsed.port || parsed.username || parsed.password
  )
    throw Error("Unapproved discovery host");
  const r = await fetcher(url, {
    headers: { "User-Agent": AGENT, Accept: "application/json,text/plain" },
    redirect: "error",
    signal: AbortSignal.timeout(20000),
  });
  if (Number(r.headers.get("content-length") || 0) > maxBytes)
    throw Error("Source response exceeds limit");
  const reader = r.body?.getReader();
  let total = 0;
  const chunks: Uint8Array[] = [];
  if (reader)
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.length;
      if (total > maxBytes) {
        await reader.cancel();
        throw Error("Source response exceeds limit");
      }
      chunks.push(part.value);
    }
  return { status: r.status, body: Buffer.concat(chunks).toString("utf8") };
}
export async function discoverBoard(
  source: { board_token: string; label: string; keywords: string[]; provider?: "greenhouse" | "lever" },
  fetcher: typeof fetch = fetch,
  now = new Date(),
) {
  const url = boardURL(source.board_token, source.provider),
    robots = await boundedFetch(
      `${new URL(url).origin}/robots.txt`,
      128000,
      fetcher,
    );
  if (
    robots.status !== 404 &&
    (robots.status !== 200 || !robotsAllows(robots.body, new URL(url).pathname + new URL(url).search))
  )
    return {
      state: "skipped" as const,
      detail: "Robots unavailable or disallows API path; no jobs requested.",
      jobs: [], observed_ids: [], complete: false,
    };
  if (
    robots.status === 200 &&
    /^\s*crawl-delay\s*:\s*(?:[1-9]\d*|0?\.\d*[1-9])/im.test(robots.body)
  )
    return {
      state: "skipped" as const,
      detail:
        "Robots specifies crawl delay; manual review required before automated access.",
      jobs: [], observed_ids: [], complete: false,
    };
  const response = await boundedFetch(url, 4 * 1024 * 1024, fetcher);
  if (response.status === 429)
    return {
      state: "skipped" as const,
      detail: "Provider rate limited request; no immediate retry.",
      jobs: [], observed_ids: [], complete: false,
    };
  if (response.status !== 200)
    throw Error(`Provider returned HTTP ${response.status}`);
  const data = JSON.parse(response.body);
  const records = source.provider === "lever" ? data : data.jobs;
  if (!Array.isArray(records) || records.length > 5000)
    throw Error("Invalid or oversized provider payload");
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  const observed_ids: string[] = records.filter(j => j && ["string", "number"].includes(typeof j.id)).map(j => String(j.id));
  const complete = observed_ids.length === records.length && new Set(observed_ids).size === records.length &&
    observed_ids.every(id => id.length > 0 && id.length <= 200) &&
    (source.provider === "lever" || data.meta?.total === undefined || data.meta.total === records.length);
  const jobs = [];
  for (const original of records) {
    if (!original || typeof original !== "object") continue;
    const j = source.provider === "lever" ? {
      id: original.id, title: original.text, absolute_url: original.hostedUrl,
      location: {name: original.categories?.location || ""},
      content: [original.descriptionPlain || original.description || "",
        ...(Array.isArray(original.lists) ? original.lists.map((l: {text?: string; content?: string}) => `${l.text || ""}\n${l.content || ""}`) : []),
        original.additionalPlain || original.additional || ""].join("\n"),
    } : original;
    if (
      typeof j.title !== "string" ||
      typeof j.content !== "string" ||
      typeof j.absolute_url !== "string" ||
      !["string", "number"].includes(typeof j.id)
    )
      continue;
    const location = String(j.location?.name || "").slice(0, 500);
    const london = /\blondon\b/i.test(location) && !/\b(?:ontario|canada|connecticut|united states|south africa|ohio|new london)\b/i.test(location);
    const ukRemote = /remote.{0,30}\b(?:UK|United Kingdom)\b|\b(?:UK|United Kingdom)\b.{0,30}remote/i.test(location);
    if (!london && !ukRemote) continue;
    const raw_jd = htmlText(j.content);
    if (
      raw_jd.length < 20 ||
      raw_jd.length > 80000 ||
      !source.keywords.some((k) => phraseIn(j.title + " " + raw_jd, k))
    )
      continue;
    let link: URL;
    try {
      link = new URL(j.absolute_url);
    } catch {
      continue;
    }
    if (link.protocol !== "https:" || link.username || link.password) continue;
    link.hash = "";
    for (const key of [...link.searchParams.keys()]) if (/^utm_/i.test(key)) link.searchParams.delete(key);
    const analysis = analyseJD(raw_jd);
    if (analysis.deadline_date && analysis.deadline_date < today) continue;
    jobs.push({
      external_id: String(j.id).slice(0, 200),
      title: j.title.slice(0, 200),
      employer: source.label.slice(0, 200),
      location,
      source_url: link.toString(),
      raw_jd,
      analysis,
    });
  }
  jobs.sort(
    (a, b) => Number(b.analysis.flexible) - Number(a.analysis.flexible),
  );
  return {
    state: "success" as const,
    detail:
      "Official API listing; employer availability and eligibility still require human verification.",
    jobs: jobs.slice(0, 100), observed_ids, complete,
  };
}
