import { execFile, spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  installAcpSandboxAgent,
  prepareAcpSandboxAgent,
  resolveAcpSandboxAgentAdapter,
  type AcpSandboxAgentStatePort,
} from "./sandbox-agent.js";
import { resolvePinnedAcpRegistryAgent } from "./acp-registry-pins.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** A temp HOME plus a bin dir that holds fake tools; only `bin` and system dirs are on PATH. */
async function fakeHost(): Promise<{ home: string; bin: string; log: string; path: string }> {
  const root = await mkdtemp(join(tmpdir(), "oma-acp-install-"));
  roots.push(root);
  const home = join(root, "home");
  const bin = join(root, "bin");
  await mkdir(home, { recursive: true });
  await mkdir(bin, { recursive: true });
  return { home, bin, log: join(root, "calls.log"), path: `${bin}:/usr/bin:/bin` };
}

async function tool(bin: string, name: string, body: string): Promise<void> {
  const path = join(bin, name);
  await writeFile(path, `#!/bin/sh\n${body}\n`);
  await chmod(path, 0o755);
}

/** Sandbox exec port backed by /bin/sh on this machine, mirroring the local adapter. */
function shellSandbox(env: Record<string, string>): AcpSandboxAgentStatePort & { commands: string[] } {
  const commands: string[] = [];
  return {
    commands,
    writeFile: async () => {
      throw new Error("installer must not depend on writeFile path mapping");
    },
    exec: async (command: string) => {
      commands.push(command);
      try {
        const { stdout, stderr } = await execFileAsync("/bin/sh", ["-c", command], { env });
        return `${stdout}${stderr}`;
      } catch (error) {
        const failed = error as { stdout?: string; stderr?: string; code?: number };
        return `${failed.stdout ?? ""}${failed.stderr ?? ""}\n[exit ${failed.code ?? 1}]`;
      }
    },
  };
}

function registryPreparation(extra: Record<string, unknown> = {}) {
  return prepareAcpSandboxAgent({
    sessionId: "session_install",
    agent: { registry: "claude-acp@0.94.0", ...extra },
  });
}

describe("Harbor-style pinned ACP registry install", () => {
  it("reuses a satisfying Node and writes a launcher that execs the pinned npx package", async () => {
    const host = await fakeHost();
    await tool(host.bin, "node", 'echo v22.11.0');
    await tool(host.bin, "npx", `echo "npx $*" >> ${JSON.stringify(host.log)}`);
    await tool(host.bin, "curl", `echo "curl $*" >> ${JSON.stringify(host.log)}; exit 1`);
    const sandbox = shellSandbox({ HOME: host.home, PATH: host.path });

    const installed = await installAcpSandboxAgent(sandbox, registryPreparation({ args: ["--debug"] }));

    const launcher = join(host.home, ".oma/installed-agent/claude-acp/0.94.0/acp-launch.sh");
    expect(installed.launch.command).toBe(launcher);
    expect(installed.launch.args).toEqual(["--debug"]);
    expect((await stat(launcher)).mode & 0o111).not.toBe(0);
    await execFileAsync(launcher, ["--debug", "two words"], {
      env: { HOME: host.home, PATH: host.path },
    });
    // nvm is never downloaded when the image Node already satisfies the package engine.
    expect(await readFile(host.log, "utf8")).toBe(
      "npx -y @agentclientprotocol/claude-agent-acp@0.94.0 --debug two words\n",
    );
    await expect(stat(join(host.home, ".nvm"))).rejects.toThrow();
  });

  it("installs Node 22 through nvm when the image Node is too old and prefers it in the launcher", async () => {
    const host = await fakeHost();
    await tool(host.bin, "node", "echo v18.19.0");
    await tool(host.bin, "npx", `echo "old-npx $*" >> ${JSON.stringify(host.log)}`);
    // Fake nvm installer: nvm.sh defines `nvm` which materializes a Node 22 toolchain.
    await tool(host.bin, "curl", [
      `echo "curl $*" >> ${JSON.stringify(host.log)}`,
      "cat <<'INSTALLER'",
      'mkdir -p "$NVM_DIR"',
      "cat > \"$NVM_DIR/nvm.sh\" <<'NVMSH'",
      "nvm() {",
      '  if [ "$1" = install ]; then',
      '    d="$NVM_DIR/versions/node/v22.12.0/bin"; mkdir -p "$d"',
      `    printf '#!/bin/sh\\necho v22.12.0\\n' > "$d/node"`,
      `    printf '#!/bin/sh\\necho "nvm-npx $*" >> ${host.log}\\n' > "$d/npx"`,
      '    chmod +x "$d/node" "$d/npx"',
      "  fi",
      "}",
      "NVMSH",
      "INSTALLER",
    ].join("\n"));
    const sandbox = shellSandbox({ HOME: host.home, PATH: host.path });

    const installed = await installAcpSandboxAgent(sandbox, registryPreparation());
    await execFileAsync(installed.launch.command, [], { env: { HOME: host.home, PATH: host.path } });

    const calls = (await readFile(host.log, "utf8")).trim().split("\n");
    expect(calls[0]).toContain("https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.2/install.sh");
    expect(calls.at(-1)).toBe("nvm-npx -y @agentclientprotocol/claude-agent-acp@0.94.0");
  });

  it("is idempotent: a second install leaves one launcher and does not reinstall Node", async () => {
    const host = await fakeHost();
    await tool(host.bin, "node", "echo v24.1.0");
    await tool(host.bin, "npx", "true");
    await tool(host.bin, "curl", `echo "curl $*" >> ${JSON.stringify(host.log)}; exit 1`);
    const sandbox = shellSandbox({ HOME: host.home, PATH: host.path });

    const first = await installAcpSandboxAgent(sandbox, registryPreparation());
    const content = await readFile(first.launch.command, "utf8");
    const second = await installAcpSandboxAgent(sandbox, registryPreparation());

    expect(second.launch.command).toBe(first.launch.command);
    expect(await readFile(second.launch.command, "utf8")).toBe(content);
    await expect(readFile(host.log, "utf8")).rejects.toThrow();
  });

  it("fails hard with a readable error when Node cannot be provisioned", async () => {
    const host = await fakeHost();
    await tool(host.bin, "node", "echo v18.19.0");
    await tool(host.bin, "curl", "echo 'curl: (6) Could not resolve host' >&2; exit 6");
    const sandbox = shellSandbox({ HOME: host.home, PATH: host.path });

    await expect(installAcpSandboxAgent(sandbox, registryPreparation())).rejects.toThrow(
      /ACP agent install failed for claude-acp@0\.94\.0[\s\S]*Could not resolve host/,
    );
    await expect(stat(join(host.home, ".oma/installed-agent/claude-acp/0.94.0/acp-launch.sh")))
      .rejects.toThrow();
  });

  it("treats a sandbox exec that throws as an install failure, not a fallback", async () => {
    const sandbox: AcpSandboxAgentStatePort = {
      writeFile: async () => undefined,
      exec: async () => {
        throw new Error("sandbox gone");
      },
    };
    await expect(installAcpSandboxAgent(sandbox, registryPreparation())).rejects.toThrow(
      /ACP agent install failed for claude-acp@0\.94\.0: sandbox gone/,
    );
  });

  it("keeps launch env values out of the launcher file", async () => {
    const host = await fakeHost();
    await tool(host.bin, "node", "echo v22.11.0");
    await tool(host.bin, "npx", "true");
    const sandbox = shellSandbox({ HOME: host.home, PATH: host.path });
    const preparation = registryPreparation({
      env: { ANTHROPIC_API_KEY: "sk-ant-should-never-be-written", CUSTOM_FLAG: "visible-only-at-spawn" },
    });

    const installed = await installAcpSandboxAgent(sandbox, preparation);
    const launcher = await readFile(installed.launch.command, "utf8");

    expect(installed.launch.env.CUSTOM_FLAG).toBe("visible-only-at-spawn");
    expect(launcher).not.toContain("sk-ant-should-never-be-written");
    expect(launcher).not.toContain("visible-only-at-spawn");
    expect(sandbox.commands.join("\n")).not.toContain("sk-ant-should-never-be-written");
  });

  it("leaves an explicit command (local distribution) untouched and runs nothing", async () => {
    const sandbox = shellSandbox({ HOME: "/nonexistent", PATH: "/usr/bin:/bin" });
    const preparation = prepareAcpSandboxAgent({
      sessionId: "session_local",
      agent: { id: "claude-acp", command: "/opt/agents/claude-agent-acp", args: ["--x"] },
    });

    const installed = await installAcpSandboxAgent(sandbox, preparation);

    expect(installed.launch.command).toBe("/opt/agents/claude-agent-acp");
    expect(installed.launch.args).toEqual(["--x"]);
    expect(sandbox.commands).toEqual([]);
  });

  it("keeps the claude-code native resume adapter for the registry launcher", () => {
    const preparation = registryPreparation();
    expect(preparation.adapter).toEqual({ id: "claude-code", provenance: "harbor", nativeResume: true });
    expect(preparation.binding.adapterId).toBe("claude-code");
    expect(preparation.launch.env.CLAUDE_CONFIG_DIR).toBe(preparation.binding.nativePath);
    expect(resolveAcpSandboxAgentAdapter({
      id: "claude-acp",
      command: "/home/user/.oma/installed-agent/claude-acp/0.94.0/acp-launch.sh",
    }).id).toBe("claude-code");
  });

  it.each([
    ["claude-acp", /must pin a version/],
    ["claude-acp@latest", /must pin a version/],
    ["claude-acp@0.93.0", /not pinned.*claude-acp@0\.94\.0/],
    ["unknown-agent@1.0.0", /Unknown ACP registry agent "unknown-agent"/],
  ])("rejects registry ref %s", (registry, message) => {
    expect(() => prepareAcpSandboxAgent({ sessionId: "s", agent: { registry } })).toThrow(message);
  });

  it("rejects both command and registry, and neither", () => {
    expect(() => prepareAcpSandboxAgent({
      sessionId: "s",
      agent: { registry: "claude-acp@0.94.0", command: "claude-agent-acp" },
    })).toThrow(/exactly one of command or registry/);
    expect(() => prepareAcpSandboxAgent({ sessionId: "s", agent: {} })).toThrow(
      /exactly one of command or registry/,
    );
  });

  it("rejects an id that contradicts the registry entry", () => {
    expect(() => prepareAcpSandboxAgent({
      sessionId: "s",
      agent: { id: "codex-acp", registry: "claude-acp@0.94.0" },
    })).toThrow(/id "codex-acp" does not match registry agent "claude-acp"/);
  });

  it("reports distributions other than npx as unsupported instead of guessing", () => {
    const catalog = [{
      id: "binary-only",
      name: "Binary only",
      version: "1.0.0",
      distribution: {
        binary: { "linux-x86_64": { archive: "https://example.test/a.tar.gz", cmd: "./a" } },
      },
    }];
    expect(() => resolvePinnedAcpRegistryAgent("binary-only@1.0.0", catalog)).toThrow(
      /binary-only@1\.0\.0 has no npx distribution; only npx registry installs are supported/,
    );
  });

  it("refuses to bake a provider secret key into the launcher from registry env", () => {
    const catalog = [{
      id: "leaky",
      name: "Leaky",
      version: "1.0.0",
      distribution: { npx: { package: "leaky@1.0.0", env: { ANTHROPIC_API_KEY: "x" } } },
    }];
    expect(() => resolvePinnedAcpRegistryAgent("leaky@1.0.0", catalog)).toThrow(
      /must not set provider secret ANTHROPIC_API_KEY/,
    );
  });
});

describe("pinned claude-acp launcher smoke", () => {
  it("the generated launcher speaks ACP initialize through a fake npx", async () => {
    const host = await fakeHost();
    await tool(host.bin, "node", "echo v22.11.0");
    // Fake npx answers one ACP initialize request on stdio with the package it was asked for.
    await tool(host.bin, "npx", [
      "read line",
      'id=$(printf "%s" "$line" | sed -n \'s/.*"id":\\([0-9]*\\).*/\\1/p\')',
      'printf \'{"jsonrpc":"2.0","id":%s,"result":{"protocolVersion":1,"agentInfo":{"name":"%s"}}}\\n\' "$id" "$2"',
    ].join("\n"));
    const sandbox = shellSandbox({ HOME: host.home, PATH: host.path });
    const installed = await installAcpSandboxAgent(sandbox, registryPreparation());

    const child = spawn(installed.launch.command, [], { env: { HOME: host.home, PATH: host.path } });
    child.stdin.end(`${JSON.stringify({ jsonrpc: "2.0", id: 7, method: "initialize", params: { protocolVersion: 1 } })}\n`);
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    await new Promise((resolve) => child.on("close", resolve));

    expect(JSON.parse(stdout.trim())).toEqual({
      jsonrpc: "2.0",
      id: 7,
      result: { protocolVersion: 1, agentInfo: { name: "@agentclientprotocol/claude-agent-acp@0.94.0" } },
    });
  });
});
