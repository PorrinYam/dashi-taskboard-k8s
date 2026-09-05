#!/usr/bin/env node
// Build an isolated, parallel-installable launcher from this K8s branch.
//
//   node scripts/build-k8s-launcher.mjs            # build only
//   node scripts/build-k8s-launcher.mjs --install  # build, then install to /Applications
//   node scripts/build-k8s-launcher.mjs --install --start
//
// The artifact is deliberately isolated from an upstream install so both can coexist:
//   - distinct bundle identifier and .app name (src-tauri/tauri.k8s.conf.json)
//   - distinct data/log directory (TASKBOARD_INSTANCE_SUFFIX, baked in at compile time)
//   - updater disabled, so it can never self-replace with an upstream release
// The board port needs no work: the launcher already falls back to a free loopback port.
//
// This build is unsigned/ad-hoc. For a distributable signed+notarized DMG, configure the
// Apple secrets in release-macos.yml and push a tag instead.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = "aarch64-apple-darwin";
const instanceSuffix = " K8s";
const appName = `Codex Taskboard${instanceSuffix}.app`;
const overlay = "src-tauri/tauri.k8s.conf.json";
const args = process.argv.slice(2);
const install = args.includes("--install");
const start = args.includes("--start");

function run(command, commandArgs, options = {}) {
  console.log(`\n$ ${command} ${commandArgs.join(" ")}`);
  const result = spawnSync(command, commandArgs, {
    cwd: projectRoot,
    stdio: "inherit",
    env: { ...process.env, ...options.env },
  });
  if (result.status !== 0) {
    throw new Error(`${command} failed with exit code ${result.status ?? "null"}`);
  }
}

run("npm", ["run", "app:prepare", "--", "--target", target]);
run("npx", ["tauri", "build", "--target", target, "--bundles", "app", "--config", overlay], {
  env: { TASKBOARD_INSTANCE_SUFFIX: instanceSuffix },
});

const builtApp = path.join(projectRoot, "src-tauri", "target", target, "release", "bundle", "macos", appName);
if (!existsSync(builtApp)) {
  throw new Error(`Expected build output is missing: ${builtApp}`);
}
console.log(`\n构建产物: ${builtApp}`);

if (!install) {
  console.log("未安装。加 --install 安装到 /Applications。");
  process.exit(0);
}

// Ad-hoc signing keeps the bundled node sidecar launchable without a Developer ID.
run("codesign", ["--force", "--deep", "--sign", "-", builtApp]);

const installedApp = path.join("/Applications", appName);
await rm(installedApp, { recursive: true, force: true });
await cp(builtApp, installedApp, { recursive: true });
console.log(`已安装: ${installedApp}`);
console.log(`数据目录将是: ~/Library/Application Support/Codex Taskboard${instanceSuffix}`);

if (start) {
  run("open", ["-n", installedApp]);
} else {
  console.log("启动前请先退出另一个 launcher，两者不能同时持有 ChatGPT 注入权。");
}
