import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
function run(mode: string) {
  const dir = mkdtempSync(join(tmpdir(), "ying-career-fixture-")),
    fixture = join(dir, "network.mjs"),
    log = join(dir, "calls.json");
  writeFileSync(
    fixture,
    `import {writeFileSync} from 'node:fs';
const mode=process.env.CAREER_FIXTURE_MODE,calls=[];
globalThis.fetch=async(url,options={})=>{
 const u=new URL(url);let query='';
 if(u.hostname==='api.supabase.com'){
  query=JSON.parse(options.body).query;calls.push({host:u.hostname,query});writeFileSync(process.env.CAREER_FIXTURE_LOG,JSON.stringify(calls));
  if(query.startsWith('select s.*')) return Response.json(mode==='empty'?[]:[{id:'70000000-0000-4000-8000-000000000001',user_id:'00000000-0000-4000-8000-000000000071',provider:'greenhouse',enabled:true,approved_at:'2026-10-19T08:00:00Z',board_token:'fixture-studio',label:'Fixture Studio',keywords:['design']}]);
  return Response.json(query.includes('as added')?[{added:1}]:[]);
 }
 if(u.hostname!=='boards-api.greenhouse.io')throw Error('Unexpected external access');
 calls.push({host:u.hostname,path:u.pathname});writeFileSync(process.env.CAREER_FIXTURE_LOG,JSON.stringify(calls));
 if(u.pathname==='/robots.txt')return new Response('',{status:404});
 if(mode==='limited')return new Response('',{status:429});
 return Response.json({jobs:[{id:1,title:'Design assistant',location:{name:'London'},content:'Design assistant. Part-time 16 hours per week.',absolute_url:'https://example.org/jobs/fixture'}]});
};`,
  );
  try {
    const stdout = execFileSync(
      process.execPath,
      [
        "--experimental-strip-types",
        "--import",
        fixture,
        "scripts/discover-career.ts",
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          SUPABASE_ACCESS_TOKEN: "fixture-secret-never-log",
          CAREER_FIXTURE_MODE: mode,
          CAREER_FIXTURE_LOG: log,
        },
        encoding: "utf8",
      },
    );
    return {
      stdout,
      calls: JSON.parse(readFileSync(log, "utf8")) as {
        host: string;
        path?: string;
        query?: string;
      }[],
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
describe("complete career discovery command with isolated network", () => {
  it("makes no public board requests without approved sources", () => {
    const r = run("empty");
    expect(r.calls).toHaveLength(1);
    expect(r.stdout).toContain("0 approved source");
  });
  it("stores guarded deduplicated opportunities without overwriting application progress or logging credentials", () => {
    const r = run("success"),
      queries = r.calls.map((c) => c.query || "");
    expect(
      r.calls.filter((c) => c.host === "boards-api.greenhouse.io"),
    ).toHaveLength(2);
    const ingest = queries.find((q) => q.includes("career_ingest_discovery"))!;
    expect(ingest).toContain("2026-10-19T08:00:00Z");
    expect(ingest).toContain('"external_id":"1"');
    expect(ingest).toContain("true) as added");
    expect(queries.some(q => q.includes("update public.career_opportunities"))).toBe(false);
    expect(queries.some((q) => q.includes("career_discovery_runs"))).toBe(true);
    expect(r.stdout).not.toContain("fixture-secret-never-log");
    expect(r.stdout).not.toContain("Fixture Studio");
  });
  it("records provider rate limiting without retrying or inserting roles", () => {
    const r = run("limited");
    expect(r.calls.filter((c) => c.path?.includes("/jobs"))).toHaveLength(1);
    expect(r.calls.some((c) => c.query?.includes("with candidates"))).toBe(
      false,
    );
    expect(r.calls.some((c) => c.query?.includes("'skipped'"))).toBe(true);
  });
});
