import { z } from "zod";
import { DateTime } from "luxon";
export const profileInput = z
  .object({
    kind: z.enum([
      "skill",
      "experience",
      "education",
      "availability",
      "eligibility",
    ]),
    statement: z.string().trim().min(1).max(4000),
    keywords: z.array(z.string().trim().min(2).max(80)).max(30),
    source_url: z
      .string()
      .url()
      .max(2000)
      .refine((s) => /^https?:\/\//.test(s))
      .nullable(),
    source_text: z.string().trim().min(1).max(12000),
    verification: z.enum(["unverified", "user_verified", "rejected"]),
  })
  .strict();
export const jobInput = z
  .object({
    title: z.string().trim().min(1).max(200),
    employer: z.string().trim().min(1).max(200),
    source_url: z
      .string()
      .url()
      .max(2000)
      .refine((s) => /^https?:\/\//.test(s)),
    raw_jd: z.string().trim().min(20).max(80000),
    location: z.string().max(500).default(""),
  })
  .strict();
export type Claim = z.infer<typeof profileInput> & {
  id: string;
  verified_at?: string | null;
};
export type Requirement = { kind: "essential" | "desirable"; quote: string };
export type Analysis = {
  requirements: Requirement[];
  deadline_date: string | null;
  deadline_quote: string | null;
  hours: { min: number; max: number; quote: string } | null;
  flexible: boolean;
  flexibility_quote: string | null;
  eligibility_risks: string[];
  warnings: string[];
  engine: string;
};
export const policyInput = z
  .object({
    decision: z.enum(["unknown", "allowed", "analysis_only", "prohibited"]),
    source_url: z
      .string()
      .url()
      .max(2000)
      .refine((s) => /^https?:\/\//.test(s)),
    quote: z.string().trim().min(10).max(12000),
    reviewed: z.literal(true),
  })
  .strict();
export function analyseJD(text: string): Analysis {
  const lines = text
    .replace(/\r\n/g, "\n")
    .split(/\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const requirements: Requirement[] = [];
  let section: Requirement["kind"] | null = null;
  for (const line of lines) {
    if (
      /^(?:essential(?:\s+(?:criteria|requirements|skills|qualifications))?|must[- ]haves?|必备(?:要求|条件)?)\s*[:：]?$/i.test(
        line,
      )
    ) {
      section = "essential";
      continue;
    }
    if (
      /^(?:desirable(?:\s+(?:criteria|requirements|skills|qualifications))?|nice[- ]to[- ]haves?|加分(?:项|条件)?)\s*[:：]?$/i.test(
        line,
      )
    ) {
      section = "desirable";
      continue;
    }
    if (
      /^(?:benefits|salary|about us|how to apply|application|responsibilities|duties|福利|职责)\s*:?$/i.test(
        line,
      )
    )
      section = null;
    const explicit = /\b(must|required|essential)\b|必须|必备/i.test(line)
      ? "essential"
      : /\b(desirable|preferred|advantage)\b|加分/i.test(line)
        ? "desirable"
        : null;
    if ((section || explicit) && line.length > 8 && line.length <= 2000)
      requirements.push({
        kind: explicit || section!,
        quote: line.replace(/^[-*•]\s*/, ""),
      });
  }
  const deadlineLine =
    lines.find((s) => /deadline|closing date|apply by|截止/i.test(s)) || null;
  let deadline_date: string | null = null;
  if (deadlineLine) {
    const iso = deadlineLine.match(/\b20\d{2}-\d{2}-\d{2}\b/);
    const uk = deadlineLine.match(
      /\b\d{1,2}\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+20\d{2}\b/i,
    );
    const d = iso
      ? DateTime.fromISO(iso[0])
      : uk
        ? DateTime.fromFormat(uk[0], "d MMMM yyyy", { locale: "en-GB" })
        : null;
    if (d?.isValid) deadline_date = d.toISODate();
  }
  const hm = text.match(
    /\b(\d{1,2}(?:\.\d+)?)\s*(?:[-–]\s*(\d{1,2}(?:\.\d+)?))?\s*(?:hours?|hrs?)\s*(?:per\s*week|\/\s*week|weekly|a week)/i,
  );
  const min = hm ? Number(hm[1]) : 0,
    max = hm ? Number(hm[2] || hm[1]) : 0;
  const hours =
    hm && min > 0 && max >= min && max <= 168
      ? { min, max, quote: hm[0] }
      : null;
  const flex =
    lines.find((s) =>
      /part[- ]time|flexible hours|job[- ]share|兼职|弹性/i.test(s),
    ) || null;
  const eligibility_risks = lines
    .filter((s) =>
      /right to work|visa|sponsor|eligib|DBS|security clearance|student|工作许可|签证/i.test(
        s,
      ),
    )
    .slice(0, 20);
  const warnings = [
    "规则提取，完整 JD 是权威来源；没有提取到不代表没有该要求。",
    "工作许可、签证工时和雇主资格要求需人工核实；系统不推定你有资格。",
  ];
  if (!requirements.length)
    warnings.push("未识别明确的 essential/desirable 要求，暂不评分。");
  if (!deadline_date) warnings.push("截止日期未知或年份不明确，不推算日期。");
  return {
    requirements: requirements.slice(0, 80),
    deadline_date,
    deadline_quote: deadlineLine,
    hours,
    flexible: !!flex,
    flexibility_quote: flex,
    eligibility_risks,
    warnings,
    engine: "rules-v1",
  };
}
const normalized = (s: string) =>
  s.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
export function phraseIn(haystack: string, phrase: string) {
  const a = normalized(haystack),
    b = normalized(phrase);
  if (!b) return false;
  let i = a.indexOf(b);
  while (i >= 0) {
    if (
      !/[a-z0-9]/i.test(b[0]) ||
      ((i === 0 || !/[a-z0-9]/i.test(a[i - 1])) &&
        (i + b.length === a.length || !/[a-z0-9]/i.test(a[i + b.length])))
    )
      return true;
    i = a.indexOf(b, i + 1);
  }
  return false;
}
export function matchJob(analysis: Analysis, claims: Claim[]) {
  const verified = claims.filter(
    (c) =>
      c.verification === "user_verified" &&
      c.source_text.trim() &&
      c.verified_at,
  );
  const rows = analysis.requirements.map((r) => ({
    ...r,
    evidence: verified
      .filter((c) =>
        c.keywords.some(
          (k) =>
            phraseIn(r.quote, k) &&
            phraseIn(c.statement, k) &&
            phraseIn(c.source_text, k),
        ),
      )
      .map((c) => ({
        id: c.id,
        statement: c.statement,
        source_url: c.source_url,
        source_text: c.source_text,
      })),
  }));
  const essential = rows.filter((r) => r.kind === "essential"),
    desirable = rows.filter((r) => r.kind === "desirable");
  const essentialCoverage = essential.length
    ? essential.filter((r) => r.evidence.length).length / essential.length
    : null;
  const desirableCoverage = desirable.length
    ? desirable.filter((r) => r.evidence.length).length / desirable.length
    : null;
  const denominator =
    (essential.length ? 75 : 0) + (desirable.length ? 15 : 0) + 10;
  const score = rows.length
    ? Math.round(
        (((essentialCoverage || 0) * 75 +
          (desirableCoverage || 0) * 15 +
          (analysis.flexible ? 10 : 0)) /
          denominator) *
          100,
      )
    : null;
  return {
    score,
    rows,
    essentialCoverage,
    desirableCoverage,
    flexibilityPoints: analysis.flexible ? 10 : 0,
    explanation:
      "按已核实原文关键词计算证据覆盖：essential 75、desirable 15、兼职/弹性10；缺失要求类别不计入分母。关键词重合不是达到经验年限等完整要求的证明，缺少证据不等于不具备能力。不是录用概率。",
    generated_at: new Date().toISOString(),
  };
}
export type Policy = {
  decision: string;
  quote: string | null;
  source_url: string | null;
  reviewed_at: string | null;
};
export function canDraft(policy: Policy | null) {
  if (!policy?.reviewed_at || !policy.source_url || !policy.quote)
    return {
      allowed: false,
      reason: "雇主 AI 政策尚未核实；仅允许分析 JD，不生成申请材料。",
    };
  if (policy.decision !== "allowed")
    return {
      allowed: false,
      reason: "雇主 AI 政策限制或未知，申请材料生成功能已禁用。",
    };
  // Restrictive language wins even if the user selected allowed.
  if (
    /(?:do not|must not|not allowed|prohibit|ban(?:ned)?|no use of|without|不得|禁止|不允许).{0,100}(?:AI|artificial intelligence|生成式)|(?:AI|artificial intelligence).{0,80}(?:prohibit|not permitted|not allowed|must not|禁止)/i.test(
      policy.quote,
    )
  )
    return {
      allowed: false,
      reason: "政策原文包含限制信号，请人工复核；不生成申请材料。",
    };
  return { allowed: true, reason: "用户已核实允许使用；发送前仍须本人审阅。" };
}
export function draftMaterial(
  kind: "cv" | "cover_letter" | "personal_statement",
  job: { title: string; employer: string },
  claims: Claim[],
  policy: Policy,
) {
  const gate = canDraft(policy);
  if (!gate.allowed) throw Error(gate.reason);
  const verified = claims.filter(
    (c) =>
      c.verification === "user_verified" &&
      c.verified_at &&
      c.source_text.trim(),
  );
  if (!verified.length)
    throw Error("请先添加并核实至少一条有原文来源的职业资料。");
  const facts = verified
    .map((c) => `- ${c.statement} [证据 ${c.id}]`)
    .join("\n");
  const heading = {
    cv: "CV evidence draft",
    cover_letter: "Cover letter evidence draft",
    personal_statement: "Personal statement evidence draft",
  }[kind];
  const intro =
    kind === "cv"
      ? "Verified experience and qualifications"
      : `Re: ${job.title} — ${job.employer}\n\nThe following verified evidence is selected for this application. Please review relevance and add your own motivation before use.`;
  return {
    body: `# ${heading}\n\n${job.title} · ${job.employer}\n\n${intro}\n\n${facts}\n\n[待本人补充：动机、联系信息及与具体要求的关系。不要把本草稿视为可直接提交的最终材料。]`,
    evidence: verified,
    policy,
    engine: "evidence-template-v1",
  };
}
