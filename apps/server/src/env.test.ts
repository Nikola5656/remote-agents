import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { configFromEnv } from "./env";

const KEYS = [
  "NODE_ENV",
  "APP_USERNAME",
  "APP_PASSWORD",
  "APP_PASSWORD_HASH",
  "SESSION_SECRET",
  "SESSION_DAYS",
  "WORKER_TOKEN",
  "PUBLIC_ORIGIN",
  "SESSION_DIR",
  "PORT",
  "TRUST_PROXY",
  "WORKER_REQUEST_TIMEOUT_MS",
] as const;

function withEnv(values: Partial<Record<(typeof KEYS)[number], string>>, run: () => void): void {
  const old = new Map(KEYS.map((key) => [key, process.env[key]]));
  try {
    for (const key of KEYS) delete process.env[key];
    Object.assign(process.env, values);
    run();
  } finally {
    for (const key of KEYS) {
      const value = old.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function productionEnv(): Partial<Record<(typeof KEYS)[number], string>> {
  return {
    NODE_ENV: "production",
    APP_USERNAME: "operator",
    APP_PASSWORD_HASH: `${"ab".repeat(16)}:${"cd".repeat(64)}`,
    SESSION_SECRET: "s".repeat(32),
    WORKER_TOKEN: "w".repeat(32),
    PUBLIC_ORIGIN: "https://control.example",
    SESSION_DIR: path.resolve("production-sessions"),
    PORT: "3847",
    TRUST_PROXY: "1",
  };
}

test("production config accepts explicit strong and distinct credentials", () => {
  withEnv(productionEnv(), () => {
    const config = configFromEnv();
    assert.equal(config.environment, "production");
    assert.equal(config.publicOrigin, "https://control.example");
    assert.equal(config.trustProxy, 1);
  });
});

test("production config rejects plaintext passwords and weak or ambiguous settings", () => {
  withEnv({ ...productionEnv(), APP_PASSWORD: "plaintext" }, () => {
    assert.throws(() => configFromEnv(), /forbids APP_PASSWORD/);
  });
  withEnv({ ...productionEnv(), SESSION_SECRET: "short" }, () => {
    assert.throws(() => configFromEnv(), /at least 32 bytes/);
  });
  withEnv({ ...productionEnv(), PUBLIC_ORIGIN: "http://control.example" }, () => {
    assert.throws(() => configFromEnv(), /HTTPS origin/);
  });
  withEnv({ ...productionEnv(), PORT: "70000" }, () => {
    assert.throws(() => configFromEnv(), /between 0 and 65535/);
  });
  withEnv({ ...productionEnv(), TRUST_PROXY: "true" }, () => {
    assert.throws(() => configFromEnv(), /TRUST_PROXY/);
  });
  withEnv({ ...productionEnv(), NODE_ENV: "prod" }, () => {
    assert.throws(() => configFromEnv(), /NODE_ENV/);
  });
  const defaultsToProduction = productionEnv();
  delete defaultsToProduction.NODE_ENV;
  withEnv({ ...defaultsToProduction, APP_PASSWORD: "plaintext" }, () => {
    assert.throws(() => configFromEnv(), /forbids APP_PASSWORD/);
  });
});
