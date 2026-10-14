import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const execute = promisify(execFile);
describe("full deployment command with simulated service boundaries", () => {
  async function fixture(mode: string[], existing?: Record<string, unknown>) {
    const dir = await mkdtemp(join(tmpdir(), "ying-test-deploy-"));
    const path = join(dir, "state.json");
    const initial = {
      functions: [
        { slug: "telegram-webhook", status: "ACTIVE", verify_jwt: true },
      ],
      secrets: { TELEGRAM_BOT_TOKEN: "fake-test-bot-token" },
      cronExists: true,
      vaultExists: true,
      jobs: [
        {
          jobid: 1,
          jobname: "existing-minute-job",
          schedule: "0 * * * *",
          active: true,
        },
        {
          jobid: 2,
          jobname: "duplicate-minute-job",
          schedule: "* * * * *",
          active: true,
        },
      ],
      vault: [],
      commands: [],
    };
    if (existing) Object.assign(initial, existing, { commands: [] });
    await writeFile(path, JSON.stringify(initial));
    try {
      const { stdout, stderr } = await execute(
        process.execPath,
        [
          "--import",
          resolve("tests/fixtures/notification-network.mjs"),
          resolve("scripts/deploy-notifications.mjs"),
          ...mode,
        ],
        {
          env: {
            ...process.env,
            npm_execpath: resolve("tests/fixtures/notification-cli.mjs"),
            YING_TEST_DEPLOY_STATE: path,
          },
          timeout: 30000,
        },
      );
      return {
        stdout,
        stderr,
        state: JSON.parse(await readFile(path, "utf8")),
        initial,
      };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  it("inspects without mutations", async () => {
    const result = await fixture(["--inspect"]);
    expect(result.state.functions).toEqual(result.initial.functions);
    expect(result.state.secrets).toEqual(result.initial.secrets);
    expect(
      result.state.commands.every(
        (c: string[]) => c[1] === "list" || c[1] === "query",
      ),
    ).toBe(true);
    expect(result.stdout).toContain("Read-only inspection complete");
  });
  it("deploys both functions, preserves the bot, configures one minute job and logs no secret values", async () => {
    const result = await fixture([]);
    expect(result.state.functions).toHaveLength(2);
    expect(
      result.state.functions.every(
        (f: { verify_jwt: boolean }) => f.verify_jwt === false,
      ),
    ).toBe(true);
    expect(result.state.secrets.TELEGRAM_BOT_TOKEN).toBe("fake-test-bot-token");
    expect(
      result.state.jobs.filter((j: { active: boolean }) => j.active),
    ).toHaveLength(1);
    expect(result.stdout).not.toContain(result.state.secrets.SCHEDULER_SECRET);
    expect(result.stdout).not.toContain(
      result.state.secrets.TELEGRAM_WEBHOOK_SECRET,
    );
    expect(result.stdout).not.toContain("fake-test-bot-token");
    expect(result.stdout).toContain(
      "does not prove a real message was received",
    );
  });
  it("repeating deployment preserves generated secrets and the single Cron job", async () => {
    const first = await fixture([]);
    const second = await fixture([], first.state);
    expect(second.state.secrets).toEqual(first.state.secrets);
    expect(second.state.jobs).toEqual(first.state.jobs);
    expect(
      second.state.commands.some(
        (c: string[]) => c[0] === "secrets" && c[1] === "set",
      ),
    ).toBe(false);
  });
  it("verify mode makes no deployment, secret or database mutations", async () => {
    const first = await fixture([]);
    const result = await fixture(["--verify"], first.state);
    expect(result.state.secrets).toEqual(first.state.secrets);
    expect(result.state.jobs).toEqual(first.state.jobs);
    expect(
      result.state.commands.every(
        (c: string[]) => c[1] === "list" || c[1] === "query",
      ),
    ).toBe(true);
  });
});
