#!/usr/bin/env node
import fs from "fs";
import path from "path";

const root = process.cwd();

// Read manifest to get plugin id and ensure files exist
const manifestPath = path.join(root, "manifest.json");
if (!fs.existsSync(manifestPath)) {
  console.error("manifest.json not found. Did you run the build from repo root?");
  process.exit(1);
}
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const pluginId = manifest.id || "dangerous-mode";

// Destination base: env override or default iCloud Obsidian path
const home = process.env.HOME || process.env.USERPROFILE || "";
const defaultBase = path.join(
  home,
  "Library",
  "Mobile Documents",
  "iCloud~md~obsidian",
  "Documents",
  "Personal",
  ".obsidian",
  "plugins"
);
const baseDir = process.env.OBSIDIAN_PLUGINS_DIR || defaultBase;
const destDir = path.join(baseDir, pluginId);

// Files required by Obsidian; copy only if present
const files = ["manifest.json", "main.js", "styles.css"];

try {
  fs.mkdirSync(destDir, { recursive: true });
  for (const f of files) {
    const src = path.join(root, f);
    if (fs.existsSync(src)) {
      const dst = path.join(destDir, f);
      fs.copyFileSync(src, dst);
      console.log(`Copied ${f} -> ${dst}`);
    }
  }
  console.log(`Deployed plugin '${pluginId}' to ${destDir}`);
  console.log("Set OBSIDIAN_PLUGINS_DIR env var to override destination.");
} catch (err) {
  console.error("Deploy failed:", err?.message || err);
  process.exit(1);
}

