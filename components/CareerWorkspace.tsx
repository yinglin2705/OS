"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { browserDB, configured } from "@/lib/supabase";
import {
  canDraft,
  type Analysis,
  type Claim,
  type Policy,
} from "@/lib/career/engine";
type Job = {
  id: string;
  title: string;
  employer: string;
  location: string;
  source_url: string;
  raw_jd: string;
  analysis: Analysis;
  status: string;
  application_notes: string;
  policy_decision: string;
  policy_url: string | null;
  policy_quote: string | null;
  policy_reviewed_at: string | null;
  last_seen_at: string | null;
  availability: string;
  source_changed_at?: string | null;
  origin: string;
  updated_at: string;
};
type Doc = {
  id: string;
  kind: string;
  version: number;
  body: string;
  created_at: string;
  evidence_snapshot: Claim[];
  policy_snapshot: Policy;
  analysis_snapshot?: { raw_jd?: string };
};
type Source = {
  provider: string;
  id: string;
  label: string;
  board_token: string;
  keywords: string[];
  terms_url: string;
  terms_note: string;
  enabled: boolean;
  approved_at: string | null;
};
type Run = {
  id: string;
  source_id: string | null;
  state: string;
  seen: number;
  added: number;
  detail: string;
  finished_at: string;
};
type History = {
  id: string;
  opportunity_id: string;
  old_status: string | null;
  new_status: string;
  created_at: string;
};
type Match = {
  score: number | null;
  rows: {
    kind: string;
    quote: string;
    evidence: {
      id: string;
      statement: string;
      source_url: string | null;
      source_text: string;
    }[];
  }[];
  explanation: string;
};
const statuses: Record<string, string> = {
  saved: "已收藏",
  shortlisted: "候选",
  drafting: "准备材料",
  ready: "待本人申请",
  applied: "本人已申请",
  interview: "面试",
  offer: "Offer",
  rejected: "未录用",
  withdrawn: "已撤回",
  archived: "已归档",
};
const kinds: Record<string, string> = {
  skill: "技能",
  experience: "经历",
  education: "教育",
  availability: "可工作时间",
  eligibility: "资格与工作许可",
};
const emptyClaim = {
  kind: "skill",
  statement: "",
  keywords: "",
  source_url: "",
  source_text: "",
  verification: "unverified",
};
const emptyJob = {
  title: "",
  employer: "",
  location: "London",
  source_url: "",
  raw_jd: "",
};
const emptySource = {
  provider: "greenhouse",
  label: "",
  board_token: "",
  keywords: "design, creative, art, production, studio, museum, theatre",
  terms_url: "",
  terms_note: "",
  enabled: false,
};
function localTime(iso: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Europe/London",
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(iso));
}
export default function CareerWorkspace() {
  const [tab, setTab] = useState<"jobs" | "profile" | "sources">("jobs"),
    [message, setMessage] = useState("正在读取…"),
    [busy, setBusy] = useState(false),
    [authenticated, setAuthenticated] = useState(false);
  const [claims, setClaims] = useState<Claim[]>([]),
    [jobs, setJobs] = useState<Job[]>([]),
    [sources, setSources] = useState<Source[]>([]),
    [runs, setRuns] = useState<Run[]>([]),
    [history, setHistory] = useState<History[]>([]);
  const [selected, setSelected] = useState(""),
    [query, setQuery] = useState(""),
    [statusFilter, setFilter] = useState("all"),
    [flexOnly, setFlex] = useState(false),
    [includeClosed, setIncludeClosed] = useState(false);
  const [claimForm, setClaimForm] = useState(emptyClaim),
    [claimId, setClaimId] = useState(""),
    [jobForm, setJobForm] = useState(emptyJob),
    [jobId, setJobId] = useState(""),
    [showJob, setShowJob] = useState(false);
  const [sourceForm, setSourceForm] = useState(emptySource),
    [sourceId, setSourceId] = useState(""),
    [sourceApproved, setSourceApproved] = useState(false);
  const [analysis, setAnalysis] = useState<Analysis | null>(null),
    [match, setMatch] = useState<Match | null>(null),
    [docs, setDocs] = useState<Doc[]>([]),
    [document, setDocument] = useState<Doc | null>(null);
  const [observations, setObservations] = useState<{id: string; raw_jd: string; source_url: string; observed_at: string}[]>([]);
  const [matchRuns, setMatchRuns] = useState<{id: string; result: Match; created_at: string}[]>([]);
  const [policy, setPolicy] = useState({
      decision: "unknown",
      source_url: "",
      quote: "",
    }),
    [policyReviewed, setPolicyReviewed] = useState(false),
    [evidence, setEvidence] = useState<string[]>([]),
    [draftKind, setDraftKind] = useState("cv"),
    [notes, setNotes] = useState("");
  const lock = useRef(false),
    request = useRef(0);
  const job = jobs.find((j) => j.id === selected);
  const profileRevision = JSON.stringify(claims);
  async function load() {
    const db = browserDB();
    const results = await Promise.all([
      db.from("career_claims").select("*").order("created_at").limit(500),
      db
        .from("career_opportunities")
        .select("*")
        .order("updated_at", { ascending: false })
        .limit(500),
      db.from("career_sources").select("*").order("created_at").limit(100),
      db
        .from("career_discovery_runs")
        .select("*")
        .order("finished_at", { ascending: false })
        .limit(50),
      db
        .from("career_application_history")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(200),
    ]);
    if (results.some((r) => r.error))
      throw Error(
        "职业模块无法读取。请先完成007和010数据库迁移；日历等模块不受影响。",
      );
    setClaims(results[0].data || []);
    setJobs(results[1].data || []);
    setSources(results[2].data || []);
    setRuns(results[3].data || []);
    setHistory(results[4].data || []);
    if (results[0].data?.length === 500 || results[1].data?.length === 500)
      setMessage("当前显示最多500条，请清理历史资料后继续。");
  }
  useEffect(() => {
    (async () => {
      if (!configured()) throw Error("尚未配置Supabase。");
      const {
        data: { user },
      } = await browserDB().auth.getUser();
      if (!user) throw Error("请先返回日历登录。");
      setAuthenticated(true);
      setMessage("");
      await load();
    })().catch((e) => setMessage(e.message));
  }, []);
  async function api(body: Record<string, unknown>) {
    const r = await fetch("/api/career", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await r.json();
    if (!r.ok) throw Error(data.error || "请求失败");
    return data;
  }
  async function mutate(body: Record<string, unknown>, success: string) {
    if (lock.current) return false;
    lock.current = true;
    setBusy(true);
    try {
      await api(body);
      setMessage(success);
      await load();
      return true;
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "操作失败");
      return false;
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  useEffect(() => {
    const current = ++request.current;
    setAnalysis(null);
    setMatch(null);
    setDocs([]);
    setDocument(null);
    setObservations([]);
    setMatchRuns([]);
    setEvidence([]);
    if (!job) return;
    setPolicy({
      decision: job.policy_decision,
      source_url: job.policy_url || "",
      quote: job.policy_quote || "",
    });
    setPolicyReviewed(false);
    setNotes(job.application_notes);
    api({ action: "analyse", id: job.id })
      .then((d) => {
        if (request.current === current) {
          setAnalysis(d.analysis);
          setMatch(d.match);
          browserDB().from("career_match_runs").select("id,result,created_at").eq("opportunity_id", job.id).order("created_at", {ascending:false}).limit(20).then(r => {
            if (request.current === current && !r.error) setMatchRuns(r.data || []);
          });
        }
      })
      .catch((e) => {
        if (request.current === current) setMessage(e.message);
      });
    browserDB().from("career_job_observations").select("id,raw_jd,source_url,observed_at").eq("opportunity_id",job.id).order("observed_at",{ascending:false}).limit(10).then(r => {
      if (request.current === current && !r.error) setObservations(r.data || []);
    });
    browserDB()
      .from("career_documents")
      .select("*")
      .eq("opportunity_id", job.id)
      .order("created_at", { ascending: false })
      .limit(100)
      .then((r) => {
        if (request.current === current) {
          if (r.error) setMessage("草稿版本无法读取。");
          else setDocs(r.data || []);
        }
      });
  }, [selected, job?.updated_at, profileRevision]);
  async function remove(table: string, id: string, explanation: string) {
    if (!window.confirm(explanation + " 永久删除，不能撤销。")) return;
    const ok = await mutate({ action: "delete", table, id }, "已删除。");
    if (ok) {
      if (table === "career_opportunities") setSelected("");
      if (table === "career_documents") {
        setDocs((d) => d.filter((x) => x.id !== id));
        setDocument(null);
      }
    }
  }
  const policyValue: Policy | null = job
    ? {
        decision: job.policy_decision,
        source_url: job.policy_url,
        quote: [job.policy_quote, job.raw_jd].filter(Boolean).join("\n"),
        reviewed_at: job.policy_reviewed_at,
      }
    : null;
  const gate = job?.availability === "closed" || job?.source_changed_at
    ? { allowed: false, reason: "岗位已关闭或来源 JD 已变化；请先核实最新来源。" }
    : canDraft(policyValue);
  const exportSafe =
    !!document &&
    gate.allowed &&
    document.evidence_snapshot.every((old) =>
      claims.some(
        (current) =>
          current.id === old.id &&
          current.verification === "user_verified" &&
          !!current.verified_at &&
          current.statement === old.statement &&
          current.source_text === old.source_text &&
          current.source_url === old.source_url,
      ),
    ) &&
    document.analysis_snapshot?.raw_jd === job?.raw_jd;
  const filtered = jobs
    .filter(
      (j) =>
        (includeClosed || (j.availability !== "closed" && (!j.analysis?.deadline_date || j.analysis.deadline_date >= new Intl.DateTimeFormat("en-CA", {timeZone:"Europe/London"}).format(new Date())))) &&
        (statusFilter === "all" || j.status === statusFilter) &&
        (!flexOnly || j.analysis?.flexible) &&
        (j.title + " " + j.employer + " " + j.location)
          .toLowerCase()
          .includes(query.toLowerCase()),
    )
    .sort(
      (a, b) => Number(!!b.analysis?.flexible) - Number(!!a.analysis?.flexible),
    );
  function download(name: string, body: string) {
    const url = URL.createObjectURL(
        new Blob([body], { type: "text/plain;charset=utf-8" }),
      ),
      a = window.document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <main className="career-page">
      <Link href="/">← 日历</Link>
      <header className="knowledge-heading">
        <div>
          <p className="eyebrow">Evidence · Opportunity · Human decision</p>
          <h1>Career Agent</h1>
          <p className="muted">
            London 创意行业 · 优先兼职与弹性 · 所有申请由你决定
          </p>
        </div>
        <Link href="/manage">数据管理</Link>
      </header>
      <p role="status" aria-live="polite">
        {message}
      </p>
      <nav className="career-tabs" aria-label="职业模块">
        <button aria-pressed={tab === "jobs"} onClick={() => setTab("jobs")}>
          机会与申请 · {jobs.length}
        </button>
        <button
          aria-pressed={tab === "profile"}
          onClick={() => setTab("profile")}
        >
          Master Profile ·{" "}
          {claims.filter((c) => c.verification === "user_verified").length}
          条已核实
        </button>
        <button
          aria-pressed={tab === "sources"}
          onClick={() => setTab("sources")}
        >
          发现来源与运行记录
        </button>
      </nav>
      {authenticated && tab === "profile" && (
        <div className="career-columns">
          <section className="panel">
            <h2>{claimId ? "编辑职业资料" : "添加职业资料"}</h2>
            <p className="muted">
              一条事实对应一份证据。不会自动填入学历、经历或工作许可。核实指你本人核对原文，并非系统背调。
            </p>
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                const ok = await mutate(
                  {
                    action: "claim",
                    id: claimId || undefined,
                    data: {
                      ...claimForm,
                      keywords: claimForm.keywords
                        .split(/[,，]/)
                        .map((s) => s.trim())
                        .filter(Boolean),
                      source_url: claimForm.source_url || null,
                    },
                  },
                  "职业资料已保存。",
                );
                if (ok) {
                  setClaimForm(emptyClaim);
                  setClaimId("");
                }
              }}
            >
              <label>
                类型
                <select
                  value={claimForm.kind}
                  onChange={(e) =>
                    setClaimForm({ ...claimForm, kind: e.target.value })
                  }
                >
                  {Object.entries(kinds).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                事实描述
                <textarea
                  required
                  maxLength={4000}
                  value={claimForm.statement}
                  onChange={(e) =>
                    setClaimForm({ ...claimForm, statement: e.target.value })
                  }
                />
              </label>
              <label>
                关键词（逗号分隔，应同时出现在事实和证据原文中）
                <input
                  value={claimForm.keywords}
                  onChange={(e) =>
                    setClaimForm({ ...claimForm, keywords: e.target.value })
                  }
                  placeholder="C4D, lighting"
                />
              </label>
              <label>
                证据链接（可选）
                <input
                  type="url"
                  value={claimForm.source_url}
                  onChange={(e) =>
                    setClaimForm({ ...claimForm, source_url: e.target.value })
                  }
                />
              </label>
              <label>
                原文证据 / 本人记录
                <textarea
                  required
                  maxLength={12000}
                  value={claimForm.source_text}
                  onChange={(e) =>
                    setClaimForm({ ...claimForm, source_text: e.target.value })
                  }
                />
              </label>
              <label>
                核实状态
                <select
                  value={claimForm.verification}
                  onChange={(e) =>
                    setClaimForm({ ...claimForm, verification: e.target.value })
                  }
                >
                  <option value="unverified">待核实：不用于匹配或草稿</option>
                  <option value="user_verified">我已核对原文，确认真实</option>
                  <option value="rejected">已否定：不使用</option>
                </select>
              </label>
              <div className="actions">
                <button className="primary" disabled={busy}>
                  保存资料
                </button>
                {claimId && (
                  <button
                    type="button"
                    onClick={() => {
                      setClaimId("");
                      setClaimForm(emptyClaim);
                    }}
                  >
                    取消编辑
                  </button>
                )}
              </div>
            </form>
          </section>
          <section className="panel">
            <div className="actions">
              <h2>Master Career Profile</h2>
              <button
                disabled={!claims.length}
                onClick={() =>
                  download(
                    "YING-private-career-profile.json",
                    JSON.stringify(claims, null, 2),
                  )
                }
              >
                导出本人资料
              </button>
            </div>
            {!claims.length && (
              <p className="muted">
                还没有资料。从一项技能、一段经历或可工作时间开始。
              </p>
            )}
            {claims.map((c) => (
              <article className="career-record" key={c.id}>
                <p>
                  <span className="tag">{kinds[c.kind]}</span>{" "}
                  <span className="tag">
                    {c.verification === "user_verified"
                      ? "本人已核实"
                      : c.verification === "rejected"
                        ? "已否定"
                        : "待核实"}
                  </span>
                </p>
                <p>{c.statement}</p>
                <p className="muted">{c.keywords.join(" · ")}</p>
                <details>
                  <summary>
                    原文来源
                    {c.verified_at ? ` · ${localTime(c.verified_at)}` : ""}
                  </summary>
                  <pre>{c.source_text}</pre>
                  {c.source_url && (
                    <a
                      href={c.source_url}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      打开证据来源 ↗
                    </a>
                  )}
                </details>
                <div className="actions">
                  <button
                    disabled={busy}
                    onClick={() => {
                      setClaimId(c.id);
                      setClaimForm({
                        kind: c.kind,
                        statement: c.statement,
                        source_text: c.source_text,
                        verification: c.verification,
                        source_url: c.source_url || "",
                        keywords: c.keywords.join(", "),
                      });
                    }}
                  >
                    编辑
                  </button>
                  <button
                    disabled={busy}
                    onClick={() =>
                      remove(
                        "career_claims",
                        c.id,
                        "删除这条职业资料？已生成版本仍保留当时的证据快照；完整清理请同时删除相关草稿。",
                      )
                    }
                  >
                    删除
                  </button>
                </div>
              </article>
            ))}
          </section>
        </div>
      )}
      {authenticated && tab === "jobs" && (
        <>
          <div className="actions career-filters">
            <input
              aria-label="搜索职业机会"
              type="search"
              placeholder="搜索职位、雇主、地点"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <select
              aria-label="申请状态筛选"
              value={statusFilter}
              onChange={(e) => setFilter(e.target.value)}
            >
              <option value="all">所有申请状态</option>
              {Object.entries(statuses).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
            <label className="career-check">
              <input
                type="checkbox"
                checked={flexOnly}
                onChange={(e) => setFlex(e.target.checked)}
              />
              只看明确兼职 / 弹性
            </label>
            <label className="career-check"><input type="checkbox" checked={includeClosed} onChange={e => setIncludeClosed(e.target.checked)} />包含已关闭 / 已截止职位</label>
            <button
              onClick={() => {
                setShowJob(!showJob);
                setJobId("");
                setJobForm(emptyJob);
              }}
            >
              {showJob ? "收起职位输入" : "＋ 粘贴 JD / 收藏职位"}
            </button>
          </div>
          {showJob && (
            <form
              className="panel career-job-form"
              onSubmit={async (e) => {
                e.preventDefault();
                const ok = await mutate(
                  { action: "job", id: jobId || undefined, data: jobForm },
                  "职位与原文已保存。JD变化时旧AI政策批准会失效，请重新核实。",
                );
                if (ok) {
                  setShowJob(false);
                  setJobForm(emptyJob);
                  setJobId("");
                }
              }}
            >
              <h2>{jobId ? "更新 JD 原文" : "保存职位原文"}</h2>
              <p className="muted">
                粘贴公开 JD
                正文；系统不自动访问这个链接。未识别的截止时间、工时与资格保持未知。
              </p>
              <div className="career-form-grid">
                <label>
                  职位名称
                  <input
                    required
                    maxLength={200}
                    value={jobForm.title}
                    onChange={(e) =>
                      setJobForm({ ...jobForm, title: e.target.value })
                    }
                  />
                </label>
                <label>
                  雇主
                  <input
                    required
                    maxLength={200}
                    value={jobForm.employer}
                    onChange={(e) =>
                      setJobForm({ ...jobForm, employer: e.target.value })
                    }
                  />
                </label>
                <label>
                  地点
                  <input
                    value={jobForm.location}
                    onChange={(e) =>
                      setJobForm({ ...jobForm, location: e.target.value })
                    }
                  />
                </label>
                <label>
                  原始职位链接
                  <input
                    required
                    type="url"
                    value={jobForm.source_url}
                    onChange={(e) =>
                      setJobForm({ ...jobForm, source_url: e.target.value })
                    }
                  />
                </label>
              </div>
              <label>
                完整 JD 原文
                <textarea
                  required
                  minLength={20}
                  maxLength={80000}
                  rows={10}
                  value={jobForm.raw_jd}
                  onChange={(e) =>
                    setJobForm({ ...jobForm, raw_jd: e.target.value })
                  }
                />
              </label>
              <button className="primary" disabled={busy}>
                保存并分析
              </button>
            </form>
          )}
          <div className="career-layout">
            <aside className="panel career-shortlist">
              <h2>机会清单 · {filtered.length}</h2>
              <p className="muted">
                明确兼职 /
                弹性优先。listed只表示近期出现在官方API，不等于雇主确认仍招聘。
              </p>
              {!filtered.length && (
                <p>
                  还没有匹配的机会。可粘贴 JD，或在发现来源中批准官方职位API。
                </p>
              )}
              {filtered.map((j) => (
                <button
                  className={`career-job ${selected === j.id ? "selected" : ""}`}
                  key={j.id}
                  onClick={() => setSelected(j.id)}
                >
                  <strong>{j.title}</strong>
                  <span>
                    {j.employer} · {j.location || "地点未知"}
                  </span>
                  <small>
                    {statuses[j.status]} ·{" "}
                    {j.analysis?.flexible ? "兼职 / 弹性" : "工时需核实"}
                  </small>
                  <small>
                    {j.availability === "closed" && <strong>来源已关闭 · </strong>}
                    {j.source_changed_at && <strong>来源已更新，待复核 · </strong>}
                    {j.last_seen_at
                      ? `API见到：${localTime(j.last_seen_at)}`
                      : "招聘有效性待核实"}
                  </small>
                  {j.last_seen_at &&
                    Date.now() - new Date(j.last_seen_at).getTime() >
                      7 * 86400000 && (
                      <small>超过7天未在API核验，请检查原始链接</small>
                    )}
                </button>
              ))}
            </aside>
            <section className="career-detail">
              {!job ? (
                <div className="panel">
                  <h2>选择一个职位</h2>
                  <p>
                    原文、要求匹配、资格风险、材料版本与申请状态会在这里显示。
                  </p>
                </div>
              ) : (
                <>
                  <section className="panel">
                    <h2>{job.title}</h2>
                    <p>
                      {job.employer} · {job.location || "地点未知"}
                    </p>
                    <div className="actions">
                      <a
                        href={job.source_url}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        本人打开原始职位 ↗
                      </a>
                      <button
                        disabled={busy}
                        onClick={() => {
                          setJobId(job.id);
                          setJobForm({
                            title: job.title,
                            employer: job.employer,
                            location: job.location,
                            source_url: job.source_url,
                            raw_jd: job.raw_jd,
                          });
                          setShowJob(true);
                        }}
                      >
                        编辑 / 更新 JD
                      </button>
                      <button
                        disabled={busy}
                        onClick={() =>
                          remove(
                            "career_opportunities",
                            job.id,
                            "删除这个机会及其全部草稿、证据快照和申请历史？",
                          )
                        }
                      >
                        删除机会
                      </button>
                    </div>
                    <details>
                      <summary>完整 JD 原文与来源</summary>
                      <pre>{job.raw_jd}</pre>
                      <p>{job.source_url}</p>
                    </details>
                  </section>
                  <section className="panel">
                    <h2>JD分析与证据匹配</h2>
                    {!analysis ? (
                      <p>正在分析…</p>
                    ) : (
                      <>
                        <div className="career-metrics">
                          <p>
                            <strong>
                              {match?.score == null
                                ? "待补充要求"
                                : `${match.score}/100`}
                            </strong>
                            <span>证据覆盖分，不是录用概率</span>
                          </p>
                          <p>
                            <strong>{analysis.deadline_date || "未知"}</strong>
                            <span>截止日期 · Europe/London</span>
                          </p>
                          <p>
                            <strong>
                              {analysis.hours
                                ? `${analysis.hours.min}–${analysis.hours.max} h/week`
                                : "工时未知"}
                            </strong>
                            <span>
                              {analysis.flexible
                                ? "原文含兼职 / 弹性信号"
                                : "没有明确兼职 / 弹性信号"}
                            </span>
                          </p>
                        </div>
                        {analysis.deadline_quote && (
                          <p className="muted">
                            截止原文：{analysis.deadline_quote}
                          </p>
                        )}
                        {analysis.deadline_date &&
                          analysis.deadline_date <
                            new Intl.DateTimeFormat("en-CA", {
                              timeZone: "Europe/London",
                            }).format(new Date()) && (
                            <p className="notice">
                              原文截止日期已过，请先核实是否仍接受申请。
                            </p>
                          )}
                        {analysis.hours && (
                          <p className="muted">
                            工时原文：{analysis.hours.quote}
                          </p>
                        )}
                        <p className="muted">{match?.explanation}</p>
                        <details><summary>历史匹配快照（最近20次）</summary>{matchRuns.map(run => <div key={run.id}>
                          <span>{localTime(run.created_at)} · {run.result.score ?? "未知"} 分</span>
                          <details><summary>查看当时的证据与解释</summary><pre>{JSON.stringify(run.result,null,2)}</pre></details>
                          <button disabled={busy} onClick={async () => {if (await mutate({action:"delete",table:"career_match_runs",id:run.id},"已删除匹配快照。")) setMatchRuns(rows=>rows.filter(r=>r.id!==run.id));}}>删除快照</button>
                        </div>)}</details>
                        {match?.rows.map((r, i) => (
                          <article className="career-requirement" key={i}>
                            <span className="tag">{r.kind}</span>
                            <p>{r.quote}</p>
                            {r.evidence.length ? (
                              r.evidence.map((e) => (
                                <details key={e.id}>
                                  <summary>
                                    关键词证据重合（需核实完整要求）：
                                    {e.statement}
                                  </summary>
                                  <pre>{e.source_text}</pre>
                                  {e.source_url && (
                                    <a
                                      href={e.source_url}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                    >
                                      证据来源 ↗
                                    </a>
                                  )}
                                </details>
                              ))
                            ) : (
                              <p className="muted">
                                未找到已核实证据；不等于你不具备此能力。
                              </p>
                            )}
                          </article>
                        ))}
                        <h3>资格风险与未知信息</h3>
                        {analysis.eligibility_risks.map((s, i) => (
                          <p className="notice" key={i}>
                            {s}
                          </p>
                        ))}
                        {analysis.warnings.map((w, i) => (
                          <p className="muted" key={i}>
                            {w}
                          </p>
                        ))}
                      </>
                    )}
                  </section>
                  <section className="panel">
                    <h2>申请进度</h2>
                    <p className="muted">
                      只记录你手动确认的进展。不提交申请、不发邮件，也不会因为生成草稿而标记已申请。
                    </p>
                    <form
                      onSubmit={async (e) => {
                        e.preventDefault();
                        const status = new FormData(e.currentTarget).get(
                          "status",
                        );
                        await mutate(
                          { action: "status", id: job.id, status, notes },
                          "申请状态已记录，未向雇主发送任何内容。",
                        );
                      }}
                    >
                      <label>
                        状态
                        <select
                          name="status"
                          key={job.id + job.status}
                          defaultValue={job.status}
                        >
                          {Object.entries(statuses).map(([k, v]) => (
                            <option key={k} value={k}>
                              {v}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        个人申请备注
                        <textarea
                          value={notes}
                          maxLength={20000}
                          onChange={(e) => setNotes(e.target.value)}
                        />
                      </label>
                      <button disabled={busy}>保存进度</button>
                    </form>
                    <details>
                      <summary>状态历史</summary>
                      {history
                        .filter((h) => h.opportunity_id === job.id)
                        .map((h) => (
                          <p key={h.id}>
                            {localTime(h.created_at)} ·{" "}
                            {h.old_status ? statuses[h.old_status] + " → " : ""}
                            {statuses[h.new_status]}{" "}
                            <button
                              disabled={busy}
                              onClick={() =>
                                remove(
                                  "career_application_history",
                                  h.id,
                                  "删除这条历史？不改变当前状态。",
                                )
                              }
                            >
                              删除记录
                            </button>
                          </p>
                        ))}
                    </details>
                  </section>
                  <section className="panel">
                    <h2>雇主 AI 政策</h2>
                    <p className="muted">
                      未知或受限时只分析JD，不生成申请材料。请从招聘说明或雇主政策取得原文，不要把未提及AI当作允许。
                    </p>
                    <form
                      onSubmit={async (e) => {
                        e.preventDefault();
                        await mutate(
                          {
                            action: "policy",
                            id: job.id,
                            data: { ...policy, reviewed: policyReviewed },
                          },
                          "政策证据已保存；生成材料还会经过数据库限制检查。",
                        );
                      }}
                    >
                      <label>
                        政策结论
                        <select
                          value={policy.decision}
                          onChange={(e) => {
                            setPolicy({ ...policy, decision: e.target.value });
                            setPolicyReviewed(false);
                          }}
                        >
                          <option value="unknown">未知：阻止生成</option>
                          <option value="allowed">原文明示允许</option>
                          <option value="analysis_only">
                            仅分析 / 不允许代写申请材料
                          </option>
                          <option value="prohibited">禁止使用AI生成</option>
                        </select>
                      </label>
                      <label>
                        政策来源链接
                        <input
                          required
                          type="url"
                          value={policy.source_url}
                          onChange={(e) => {
                            setPolicy({
                              ...policy,
                              source_url: e.target.value,
                            });
                            setPolicyReviewed(false);
                          }}
                        />
                      </label>
                      <label>
                        政策原文
                        <textarea
                          required
                          minLength={10}
                          maxLength={12000}
                          value={policy.quote}
                          onChange={(e) => {
                            setPolicy({ ...policy, quote: e.target.value });
                            setPolicyReviewed(false);
                          }}
                        />
                      </label>
                      <label className="career-check">
                        <input
                          type="checkbox"
                          checked={policyReviewed}
                          onChange={(e) => setPolicyReviewed(e.target.checked)}
                        />
                        我已核实原文和适用范围；这不是法律判断
                      </label>
                      <button disabled={busy || !policyReviewed}>
                        保存政策核实
                      </button>
                    </form>
                  </section>
                  <section className="panel">
                    <h2>申请材料与版本</h2>
                    <p className={gate.allowed ? "muted" : "notice"}>
                      {gate.reason}
                    </p>
                    <p className="muted">
                      MVP生成可追溯的证据型草稿，不进行自由扩写。请自行补充动机与叙述；不会编造经历、年限或资格。
                    </p>
                    {job.source_changed_at && <div className="notice">
                      <p>保留的 JD 与最新来源不同；更新会保留历史材料并重置 AI 政策审核。</p>
                      {observations[0] && <details><summary>预览最新来源 JD · {localTime(observations[0].observed_at)}</summary><a href={observations[0].source_url} target="_blank" rel="noopener noreferrer">查看来源 ↗</a><pre>{observations[0].raw_jd}</pre></details>}
                      <button disabled={busy || !observations.length} onClick={async () => {
                        if (window.confirm("采用最新来源 JD？旧材料保留，但需重新核实雇主 AI 政策。"))
                          await mutate({ action: "adopt_source", id: job.id, observation_id: observations[0].id, approved: true }, "JD 已更新，请重新核实政策。");
                      }}>确认采用最新 JD</button>
                    </div>}
                    <fieldset disabled={busy || !gate.allowed}>
                      <legend>选择本职位使用的已核实资料</legend>
                      {claims
                        .filter((c) => c.verification === "user_verified")
                        .map((c) => (
                          <label className="career-check" key={c.id}>
                            <input
                              type="checkbox"
                              checked={evidence.includes(c.id)}
                              onChange={(e) =>
                                setEvidence((x) =>
                                  e.target.checked
                                    ? [...x, c.id]
                                    : x.filter((id) => id !== c.id),
                                )
                              }
                            />
                            {c.statement}
                          </label>
                        ))}
                      <label>
                        材料类型
                        <select
                          value={draftKind}
                          onChange={(e) => setDraftKind(e.target.value)}
                        >
                          <option value="cv">Role-specific CV</option>
                          <option value="cover_letter">Cover letter</option>
                          <option value="personal_statement">
                            Personal statement
                          </option>
                        </select>
                      </label>
                      <button
                        disabled={!evidence.length}
                        onClick={async () => {
                          if (
                            !window.confirm(
                              "确认使用选中证据生成本职位的新草稿版本？不会发送给雇主；使用前须本人审阅。",
                            )
                          )
                            return;
                          const ok = await mutate(
                            {
                              action: "draft",
                              id: job.id,
                              kind: draftKind,
                              claim_ids: evidence,
                              approved: true,
                            },
                            "证据草稿已保存，未提交申请。",
                          );
                          if (ok) {
                            const r = await browserDB()
                              .from("career_documents")
                              .select("*")
                              .eq("opportunity_id", job.id)
                              .order("created_at", { ascending: false })
                              .limit(100);
                            if (r.error)
                              setMessage(
                                "版本已保存，但列表读取失败，请刷新。",
                              );
                            else setDocs(r.data || []);
                          }
                        }}
                      >
                        生成新的证据草稿
                      </button>
                    </fieldset>
                    <div className="career-versions">
                      {docs.map((d) => (
                        <div className="actions" key={d.id}>
                          <button onClick={() => setDocument(d)}>
                            {d.kind} · v{d.version} · {localTime(d.created_at)}
                          </button>
                          <button
                            disabled={busy}
                            onClick={() =>
                              remove(
                                "career_documents",
                                d.id,
                                "删除这个材料版本及其证据快照？",
                              )
                            }
                          >
                            删除版本
                          </button>
                        </div>
                      ))}
                    </div>
                    {document && (
                      <div>
                        <h3>
                          {document.kind} · v{document.version}
                        </h3>
                        <pre>{document.body}</pre>
                        {!exportSafe && (
                          <p className="notice">
                            当前政策、证据或JD已变化；历史版本可查看，请核实后生成新版本。
                          </p>
                        )}
                        <button
                          disabled={!exportSafe}
                          onClick={async () => {
                            if (!exportSafe) return;
                            if (
                              window.confirm(
                                "导出前确认：此版本可能包含个人信息，且仍需本人核实事实、雇主最新政策和格式。继续下载到本人设备？",
                              )
                            ) {
                              try {
                                const exported = await api({ action: "export", id: document.id, approved: true });
                                download(`career-${document.kind}-v${document.version}.md`, exported.data);
                              } catch (e) { setMessage(e instanceof Error ? e.message : "导出验证失败"); }
                            }
                          }}
                        >
                          本人审阅后导出 Markdown
                        </button>
                        <details>
                          <summary>生成时的政策与证据快照</summary>
                          <pre>
                            {JSON.stringify(
                              {
                                policy: document.policy_snapshot,
                                evidence: document.evidence_snapshot,
                              },
                              null,
                              2,
                            )}
                          </pre>
                        </details>
                      </div>
                    )}
                  </section>
                </>
              )}
            </section>
          </div>
        </>
      )}
      {authenticated && tab === "sources" && (
        <div className="career-columns">
          <section className="panel">
            <h2>{sourceId ? "编辑已批准来源" : "批准一个发现来源"}</h2>
            <p className="muted">
              支持 Greenhouse 与 Lever 官方职位 API
              API，不抓取任意招聘网站。请先阅读该来源条款，确认允许此用途；启用表示批准后台只读获取公开职位。不会发送你的职业资料。
            </p>
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                const ok = await mutate(
                  {
                    action: "source",
                    id: sourceId || undefined,
                    data: {
                      ...sourceForm,
                      keywords: sourceForm.keywords
                        .split(/[,，]/)
                        .map((s) => s.trim())
                        .filter(Boolean),
                      approved: sourceApproved,
                    },
                  },
                  "来源设置已保存。启用来源将在下一次GitHub Actions任务中只读检查。",
                );
                if (ok) {
                  setSourceForm(emptySource);
                  setSourceId("");
                  setSourceApproved(false);
                }
              }}
            >
              <label>
                雇主名称 / 来源名称
                <input
                  required
                  maxLength={200}
                  value={sourceForm.label}
                  onChange={(e) =>
                    setSourceForm({ ...sourceForm, label: e.target.value })
                  }
                />
              </label>
              <label>
                职位平台
                <select aria-label="职位平台" value={sourceForm.provider} disabled={!!sourceId} onChange={(e) => setSourceForm({ ...sourceForm, provider: e.target.value })}>
                  <option value="greenhouse">Greenhouse</option><option value="lever">Lever</option>
                </select>
              </label>
              <label>
                官方职位平台标识
                <input
                  required
                  pattern="[a-zA-Z0-9_-]{1,80}"
                  value={sourceForm.board_token}
                  onChange={(e) =>
                    setSourceForm({
                      ...sourceForm,
                      board_token: e.target.value,
                    })
                  }
                  placeholder="官方 boards.greenhouse.io/ 或 jobs.lever.co/ 之后的标识"
                />
              </label>
              <label>
                创意岗位关键词（逗号分隔）
                <input
                  required
                  value={sourceForm.keywords}
                  onChange={(e) =>
                    setSourceForm({ ...sourceForm, keywords: e.target.value })
                  }
                />
              </label>
              <label>
                已阅读的API / 来源条款链接
                <input
                  required
                  type="url"
                  value={sourceForm.terms_url}
                  onChange={(e) => {
                    setSourceForm({ ...sourceForm, terms_url: e.target.value });
                    setSourceApproved(false);
                  }}
                />
              </label>
              <label>
                条款审查记录
                <textarea
                  required
                  minLength={10}
                  maxLength={4000}
                  value={sourceForm.terms_note}
                  onChange={(e) => {
                    setSourceForm({
                      ...sourceForm,
                      terms_note: e.target.value,
                    });
                    setSourceApproved(false);
                  }}
                />
              </label>
              <label className="career-check">
                <input
                  type="checkbox"
                  checked={sourceForm.enabled}
                  onChange={(e) =>
                    setSourceForm({ ...sourceForm, enabled: e.target.checked })
                  }
                />
                启用定时只读发现
              </label>
              <label className="career-check">
                <input
                  type="checkbox"
                  checked={sourceApproved}
                  onChange={(e) => setSourceApproved(e.target.checked)}
                />
                我已审查条款，批准此来源和上述后台读取范围
              </label>
              <button className="primary" disabled={busy || !sourceApproved}>
                保存来源与批准
              </button>
            </form>
          </section>
          <section className="panel">
            <h2>已配置来源</h2>
            <p className="muted">
              每日06:17
              UTC运行（伦敦冬令时06:17、夏令时07:17）。GitHub可能延迟执行，不是准点保证。每次最多6个来源、每个100条London
              / UK remote创意职位。没有批准来源时不请求招聘API。
            </p>
            {sources.map((s) => (
              <article className="career-record" key={s.id}>
                <h3>{s.label}</h3>
                <p>
                  {s.enabled ? "已启用" : "已关闭"} · {s.board_token}
                </p>
                <p>{s.keywords.join(" · ")}</p>
                <a href={s.terms_url} target="_blank" rel="noopener noreferrer">
                  条款来源 ↗
                </a>
                <div className="actions">
                  <button
                    onClick={() => {
                      setSourceId(s.id);
                      setSourceForm({ ...s, keywords: s.keywords.join(", ") });
                      setSourceApproved(false);
                    }}
                  >
                    编辑 / 关闭
                  </button>
                  <button
                    disabled={busy}
                    onClick={() =>
                      remove(
                        "career_sources",
                        s.id,
                        "删除此发现来源？现有机会保留，不再安排新的来源读取。",
                      )
                    }
                  >
                    删除来源
                  </button>
                </div>
              </article>
            ))}
            <h2>最近发现记录</h2>
            {!runs.length && (
              <p className="muted">
                尚无运行记录。请先部署数据库与工作流，并批准来源。
              </p>
            )}
            {runs.map((r) => (
              <article className="career-record" key={r.id}>
                <strong>
                  {r.state} ·{" "}
                  {sources.find((s) => s.id === r.source_id)?.label ||
                    "来源已删除"}
                </strong>
                <p>
                  {localTime(r.finished_at)} · 候选{r.seen} · 新增{r.added}
                </p>
                <p>{r.detail}</p>
                <button
                  disabled={busy}
                  onClick={() =>
                    remove(
                      "career_discovery_runs",
                      r.id,
                      "删除此运行日志？不会删除职位。",
                    )
                  }
                >
                  删除记录
                </button>
              </article>
            ))}
          </section>
        </div>
      )}
    </main>
  );
}
