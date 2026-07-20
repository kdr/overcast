import { test } from "node:test";
import assert from "node:assert/strict";
import { tinycloudChildEnv, withProxyEgressHint } from "../../src/providers/tinycloud/envelope.ts";

// tinycloud is a bun binary that can't traverse a TLS-re-terminating egress
// proxy; OVERCAST_TINYCLOUD_DIRECT_EGRESS strips the proxy vars from its child
// env so bun connects directly, and withProxyEgressHint points a failed call at
// that fix. Both read process.env, so save/restore around each case.
function withEnv(vars: Record<string, string | undefined>, fn: () => void) {
  const keys = ["OVERCAST_TINYCLOUD_DIRECT_EGRESS", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"];
  const saved: Record<string, string | undefined> = {};
  for (const k of keys) saved[k] = process.env[k];
  try {
    for (const k of keys) delete process.env[k];
    for (const [k, v] of Object.entries(vars)) if (v !== undefined) process.env[k] = v;
    fn();
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test("tinycloudChildEnv leaves the env untouched when the knob is off", () => {
  withEnv({ HTTPS_PROXY: "http://127.0.0.1:38177" }, () => {
    const input = { HTTPS_PROXY: "http://127.0.0.1:38177", PATH: "/bin" };
    // knob off → returns the override verbatim (proxy kept, as the loop expects)
    assert.deepEqual(tinycloudChildEnv(input), input);
  });
});

test("tinycloudChildEnv strips every proxy var when the knob is on", () => {
  withEnv({ OVERCAST_TINYCLOUD_DIRECT_EGRESS: "1", HTTPS_PROXY: "x" }, () => {
    const input = {
      HTTP_PROXY: "a", HTTPS_PROXY: "b", ALL_PROXY: "c",
      http_proxy: "d", https_proxy: "e", all_proxy: "f",
      CLOUDGLUE_API_KEY: "keep", PATH: "/bin",
    };
    const out = tinycloudChildEnv(input)!;
    for (const k of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) {
      assert.equal(out[k], undefined, `${k} should be stripped`);
    }
    assert.equal(out.CLOUDGLUE_API_KEY, "keep", "non-proxy vars are preserved");
    assert.equal(out.PATH, "/bin");
  });
});

test("withProxyEgressHint appends the fix only when a proxy is set and the knob is off", () => {
  withEnv({ HTTPS_PROXY: "http://127.0.0.1:38177" }, () => {
    const hinted = withProxyEgressHint("tinycloud watch failed (exit 1): ");
    assert.match(hinted, /OVERCAST_TINYCLOUD_DIRECT_EGRESS=1/);
  });
});

test("withProxyEgressHint is a no-op when no proxy is set", () => {
  withEnv({}, () => {
    assert.equal(withProxyEgressHint("tinycloud watch failed"), "tinycloud watch failed");
  });
});

test("withProxyEgressHint is a no-op when the direct-egress knob is on", () => {
  withEnv({ OVERCAST_TINYCLOUD_DIRECT_EGRESS: "1", HTTPS_PROXY: "x" }, () => {
    assert.equal(withProxyEgressHint("boom"), "boom");
  });
});
