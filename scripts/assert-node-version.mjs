#!/usr/bin/env node
/** Semver gate for installer/doctor (owned lane; does not edit package.json). */
const MIN = process.argv[2] || "22.13.0";
const label = process.argv[3] || "remote-agents";

function parse(v) {
  return v.split(".").map((n) => Number(n.replace(/[^0-9].*$/, "")));
}

function cmp(a, b) {
  for (let i = 0; i < 3; i++) {
    const x = a[i] || 0;
    const y = b[i] || 0;
    if (x !== y) return x - y;
  }
  return 0;
}

const have = parse(process.versions.node);
const need = parse(MIN);
if (cmp(have, need) < 0) {
  console.error(`${label} requires Node >= ${MIN}; found ${process.versions.node}`);
  process.exit(1);
}
console.log(`node-ok ${process.versions.node} >= ${MIN}`);
