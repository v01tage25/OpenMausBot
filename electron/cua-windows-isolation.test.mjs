// The Windows standalone path must never adopt a foreign daemon.
//
// On Windows the default pipe is shared: another agent tool, a CLI session, or
// the user's own cua-driver install may already own it, possibly on a different
// version or permission mode. Attaching there would silently hand computer use
// to a process this app neither owns nor can reason about, so the app starts
// its own daemon on a private pipe instead. These tests pin that contract.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const source = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "cua.mjs"),
  "utf8",
);

describe("Windows local-control isolation", () => {
  it("starts its own daemon on a per-process private pipe", () => {
    expect(source).toContain("//./pipe/openmausbot-cua-${process.pid}");
  });

  it("passes that private pipe to both the daemon and the MCP proxy", () => {
    // The daemon must listen on the pipe the proxy will later connect to.
    expect(source).toContain('["serve", "--socket", privatePipe]');
    expect(source).toContain('["mcp", "--socket", privatePipe]');
  });

  it("does not adopt the shared pipe on Windows", () => {
    // The shared pipe may be probed (so logs explain why a second daemon
    // exists), but it must never be handed to the MCP proxy as its endpoint.
    expect(source).not.toMatch(/socketPath:\s*WIN_SHARED_SOCKET/);
    const standalone = source.slice(
      source.indexOf("async function attachStandalone"),
      source.indexOf("export async function startCua"),
    );
    expect(standalone).toContain("WIN_SHARED_SOCKET");
    expect(standalone).toContain("another cua-driver daemon owns the shared pipe");
  });

  it("keeps the macOS dev path separate from the Windows one", () => {
    const devBranch = source.slice(source.indexOf("} else if (process.platform"));
    expect(devBranch).toContain('process.platform === "darwin"');
  });

  it("probes pipe liveness by connecting, not by stat", () => {
    // fs.existsSync is always false for a named pipe, so a stat-first check
    // would report a healthy daemon as missing.
    const probe = source.slice(source.indexOf("function socketAlive"));
    expect(probe).toContain('process.platform !== "win32"');
    expect(probe).toContain("net.createConnection");
  });
});