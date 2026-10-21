import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  buildFullSetupScript,
  ensureEnvironmentPackages,
  hasEnvironmentPackages,
  parseExecResult,
  type PackageSandbox,
} from "../src/environment-packages";

/** A sandbox that remembers the markers it was asked to write. */
function fakeSandbox(failSetup = false) {
  const files = new Map<string, string>();
  const commands: string[] = [];
  const sandbox: PackageSandbox = {
    async exec(command) {
      commands.push(command);
      if (command.startsWith("WARM=")) {
        return `WARM=${files.get("warm") ?? "MISSING"}\nREST=${files.get("rest") ?? "MISSING"}`;
      }
      if (command.startsWith("(\nset -e")) return failSetup ? "No module named uv\n[exit 1]" : "";
      const warm = command.match(/echo "(\w+)" > \/tmp\/\.oma-setup-warm/);
      const rest = command.match(/echo "(\w+)" > \/workspace\/\.oma-setup-restored/);
      if (warm) files.set("warm", warm[1]!);
      if (rest) files.set("rest", rest[1]!);
      return "";
    },
  };
  return { sandbox, commands, files };
}

describe("environment packages", () => {
  it("reads both exec result shapes", () => {
    expect(parseExecResult("exit=2\nout\nstderr: boom")).toEqual({ exitCode: 2, stdout: "out", stderr: "boom" });
    expect(parseExecResult("some output\n[exit 1]")).toEqual({ exitCode: 1, stdout: "some output", stderr: "" });
    expect(parseExecResult("[exit 127]").exitCode).toBe(127);
    expect(parseExecResult("all good").exitCode).toBe(0);
  });

  it("knows when there is nothing to install", () => {
    expect(hasEnvironmentPackages(undefined)).toBe(false);
    expect(hasEnvironmentPackages({ pip: [], npm: [], gem: ["rails"] })).toBe(false);
    expect(hasEnvironmentPackages({ pip: ["pyodps"] })).toBe(true);
    expect(buildFullSetupScript({ pip: [] })).toBe("");
  });

  it("installs pip packages into /workspace/.venv, with uv from pip when the image lacks it", () => {
    const script = buildFullSetupScript({ pip: ["pyodps", "pandas>=2"] }, { pipIndexUrl: "https://mirror.example/simple/" });
    expect(script.startsWith("(\nset -e\n")).toBe(true);
    expect(script.endsWith("\n)")).toBe(true);
    expect(script).toContain("export UV_INDEX_URL='https://mirror.example/simple/' PIP_INDEX_URL='https://mirror.example/simple/'");
    expect(script).toContain("command -v uv");
    expect(script).toContain("$UV pip install --python /workspace/.venv/bin/python -q 'pyodps' 'pandas>=2'");
    expect(script).toContain("export PATH=/workspace/.venv/bin:");
  });

  it("writes scripts a shell can parse", () => {
    const script = buildFullSetupScript({
      apt: ["jq"],
      pip: ["it's"],
      npm: ["typescript"],
      cargo: ["ripgrep"],
      go: ["example.com/tool@latest"],
    });
    const parsed = spawnSync("bash", ["-n"], { input: script, encoding: "utf8" });
    expect(parsed.status, parsed.stderr).toBe(0);
  });

  it("installs once, then finds the container warm", async () => {
    const { sandbox, commands } = fakeSandbox();
    const first = await ensureEnvironmentPackages(sandbox, { pip: ["pyodps"] });
    expect(first).toMatchObject({ path: "fresh" });
    expect(first.error).toBeUndefined();
    expect(commands.filter((c) => c.startsWith("(\nset -e"))).toHaveLength(1);

    const second = await ensureEnvironmentPackages(sandbox, { pip: ["pyodps"] });
    expect(second.path).toBe("warm");
    expect(commands.filter((c) => c.startsWith("(\nset -e"))).toHaveLength(1);

    // A changed package list installs again.
    expect((await ensureEnvironmentPackages(sandbox, { pip: ["pyodps", "pandas"] })).path).toBe("fresh");
  });

  it("reports a failed install and leaves no marker, so the next start retries", async () => {
    const { sandbox, files } = fakeSandbox(true);
    const result = await ensureEnvironmentPackages(sandbox, { pip: ["pyodps"] });
    expect(result.path).toBe("fresh");
    expect(result.error).toMatch(/^full_setup_failed exit=1: .*No module named uv/);
    expect(files.size).toBe(0);
  });
});
