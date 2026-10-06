// Builds dist/payloads.json, a PS5 Payload Manager source, from the PS5LinkCentalizer project list.
// The hub's data.json already has the chosen stable/pre-release per project; this script only
// fetches that release's files and keeps the console payloads (.elf/.bin/.lua).
// Usage: node scripts/build.mjs   (set GITHUB_TOKEN to avoid the 60 req/h anonymous limit)
import { readFile, writeFile, mkdir } from "node:fs/promises";

const HUB = process.env.HUB_DATA ?? "https://raw.githubusercontent.com/pedrohti/PS5LinkCentalizer/main/data.json";
const headers = { Accept: "application/vnd.github+json", "User-Agent": "ps5-payloads-source" };
if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

async function gh(path) {
  const res = await fetch(`https://api.github.com${path}`, { headers });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

const PAYLOAD = /\.(elf|bin|lua)$/i;
const glob = g => new RegExp("^" + g.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$", "i");

// A release with several payload files needs "payload" (glob or list of globs) in overrides.json.
function pickPayloads(repo, o, assets) {
  const files = assets.filter(a => PAYLOAD.test(a.name));
  if (o.payload) return [o.payload].flat().flatMap(g => files.filter(a => glob(g).test(a.name)));
  if (files.length > 1) console.warn(`${repo}: ${files.length} payload files, set "payload" in overrides.json to include it`);
  return files.length === 1 ? files : [];
}

// Payload Manager detects updates by the version in the filename ("Name_v1.2.elf" -> base "Name"),
// so save as "<base>_<tag>.<ext>" like the itsPLK mirror; base has any version-like part removed,
// including one glued to the name ("PoorDS4rc51" -> "PoorDS4").
const baseName = s => s.replace(/[_-]v?\d+[\d.a-z-]*/gi, "").replace(/(rc|alpha|beta)\d+$/i, "").replace(/[^\w.-]/g, "");
// The pre-release channel gets a fixed "-pre" base so it installs side by side with the stable one
// (the manager keeps one file per base) and beta -> rc still counts as an update.
const payloadFilename = (base, channel, tag, asset) =>
  `${baseName(base)}${channel === "pre" ? "-pre" : ""}_${tag.replace(/[^\w.-]/g, "")}${asset.match(PAYLOAD)[0]}`;
const channelLabel = (channel, tag) =>
  channel === "stable" ? "stable" : tag.match(/alpha|beta|rc|nightly/i)?.[0].toLowerCase() ?? "pre-release";

const res = await fetch(HUB);
if (!res.ok) throw new Error(`hub data: ${res.status}`);
const projects = await res.json();
const overrides = Object.fromEntries(Object.entries(JSON.parse(await readFile("overrides.json", "utf8"))).map(([k, v]) => [k.toLowerCase(), v]));
const payloads = [];

for (const p of projects) {
  const repo = p.url.replace("https://github.com/", "");
  const o = overrides[repo.toLowerCase()] ?? {};
  if (o.exclude) continue;
  // The hub only lists a pre-release when it is newer than the stable one
  for (const [channel, shown] of [["stable", p.stable], ["pre", p.pre]]) {
    if (!shown) continue;
    const rel = await gh(`/repos/${repo}/releases/tags/${encodeURIComponent(shown.tag)}`);
    if (!rel) continue; // version comes from a plain git tag, no release files
    const files = pickPayloads(repo, o, rel.assets);
    for (const a of files) {
      const file = baseName(a.name.replace(PAYLOAD, ""));
      const part = file.toLowerCase().startsWith(p.name.toLowerCase()) ? file.slice(p.name.length).replace(/^[-_]+/, "") : file; // "PoorDS4-status" -> "status"
      const label = [files.length > 1 && part, channelLabel(channel, shown.tag)].filter(Boolean).join(", ");
      payloads.push({
        name: `${p.name} (${label})`,
        filename: payloadFilename(files.length > 1 ? file : p.name, channel, shown.tag, a.name),
        url: a.browser_download_url,
        source: `${p.url}/releases`,
        description: p.description,
        last_update: shown.date,
        version: shown.tag,
        category: p.category,
        checksum: a.digest?.replace(/^sha256:/, ""), // dropped by JSON.stringify when GitHub has none
      });
    }
    if (files.length) console.log(`${repo} ${channel} ${shown.tag}: ${files.map(a => a.name).join(", ")}`);
  }
}

// Never publish an empty source because of an upstream hiccup
if (!payloads.length) throw new Error("no payloads found");
await mkdir("dist", { recursive: true });
// "name" must come before "payloads" (Payload Manager parser requirement)
await writeFile("dist/payloads.json", JSON.stringify({ name: "PS5LinkCentalizer", payloads }, null, 2) + "\n");
console.log(`${payloads.length} payloads`);

// Site index = README rendered by GitHub, dark theme. Relative links (LICENSE, overrides.json) point to the repo.
const md = await fetch("https://api.github.com/markdown", {
  method: "POST", headers, body: JSON.stringify({ text: await readFile("README.md", "utf8"), mode: "gfm" }),
});
if (!md.ok) throw new Error(`markdown: ${md.status}`);
await writeFile("dist/index.html", `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PS5 Payloads Source</title>
<base href="https://github.com/pedrohti/ps5-payloads-source/blob/main/">
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/github-markdown-css/5.8.1/github-markdown-dark.min.css">
<style>
  body { margin:0; background:#0d1117; color-scheme:dark; }
  .markdown-body { box-sizing:border-box; max-width:980px; margin:0 auto; padding:32px 16px; }
</style>
</head>
<body><article class="markdown-body">
${await md.text()}
</article></body>
</html>
`);
