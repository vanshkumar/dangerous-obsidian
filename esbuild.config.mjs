import esbuild from "esbuild";

/** @type {import('esbuild').BuildOptions} */
const base = {
  entryPoints: ["main.ts"],
  bundle: true,
  sourcemap: true,
  outfile: "main.js",
  target: ["es2020"],
  format: "cjs",
  platform: "browser",
  external: [
    // Obsidian provides these at runtime
    "obsidian",
    "electron",
    "@codemirror/state",
    "@codemirror/view",
    "@codemirror/language"
  ],
};

esbuild.build(base).then(() => console.log("Built."));
