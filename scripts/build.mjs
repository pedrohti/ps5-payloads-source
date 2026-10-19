// Builds dist/payloads.json, a PS5 Payload Manager source, from the PS5LinkCentalizer project list.
// The hub's data.json already has the chosen stable/pre-release per project; this script only
// fetches that release's files and keeps the console payloads (.elf/.bin/.lua).
// Usage: node scripts/build.mjs   (set GITHUB_TOKEN to avoid the 60 req/h anonymous limit)
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import sharp from "sharp";

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

// Icons, same format as the itsPLK mirror: icons.json maps sha256(data URI) -> data URI and each
// payload carries "icon_key". The manager drops anything over 12288 chars and PS5 WebKit has no
// WebP, so icons are PNG/JPEG of at most 128px.
const MAX_ICON = 12000;
const PLK = "https://itsplk.github.io/ps5-payloads-mirror/";
const ICON_FILE = /(^|\/)(icon0|icon|logo)\.(png|jpe?g|svg)$/i;
const icons = {};

async function toDataUri(url) {
  const r = await fetch(url, { headers: { "User-Agent": headers["User-Agent"] } });
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  const img = sharp(Buffer.from(await r.arrayBuffer()), { density: 300 }); // density: sharp SVG raster
  const opaque = (await img.stats()).isOpaque;
  for (const size of [128, 96, 64, 48]) {
    const base = img.clone().resize(size, size, { fit: "inside", withoutEnlargement: true });
    const tries = [base.clone().png({ compressionLevel: 9 }), base.clone().png({ palette: true, colors: 128 })];
    if (opaque) tries.push(...[85, 75, 65].map(q => base.clone().flatten().jpeg({ quality: q })));
    for (const t of tries) {
      const { data, info } = await t.toBuffer({ resolveWithObject: true });
      const uri = `data:image/${info.format};base64,${data.toString("base64")}`;
      if (uri.length <= MAX_ICON) return uri;
    }
  }
  throw new Error(`${url}: can't fit in ${MAX_ICON} chars`);
}

// Shallowest icon0/icon/logo image in the repo's default branch
async function repoIconUrl(repo) {
  const tree = await gh(`/repos/${repo}/git/trees/HEAD?recursive=1`);
  const hit = tree?.tree?.filter(f => f.type === "blob" && ICON_FILE.test(f.path))
    .sort((a, b) => a.path.split("/").length - b.path.split("/").length || a.path.length - b.path.length)[0];
  return hit && `https://raw.githubusercontent.com/${repo}/HEAD/${hit.path.split("/").map(encodeURIComponent).join("/")}`;
}

// PLK's hand-picked icon for the same repo first, then overrides.json "icon", an image in the repo, owner avatar
const [plkList, plkIcons] = await Promise.all(["payloads_v2.json", "icons.json"]
  .map(f => fetch(PLK + f).then(r => r.ok ? r.json() : null).catch(() => null)));
const plkIcon = {};
for (const p of plkList?.payloads ?? []) {
  const data = plkIcons?.icons?.[p.icon_key];
  if (data) plkIcon[p.source.toLowerCase().replace(/\/releases\/?$/, "")] ??= data;
}
async function iconKey(p, repo, o) {
  let data = !o.icon && plkIcon[p.url.toLowerCase()];
  for (const src of data ? [] : [o.icon, !o.icon && await repoIconUrl(repo), `https://github.com/${repo.split("/")[0]}.png?size=128`]) {
    if (!src) continue;
    try { data = await toDataUri(src); break; } catch (e) { console.warn(`${repo} icon: ${e.message}`); }
  }
  if (!data) return undefined;
  const key = createHash("sha256").update(data).digest("hex");
  icons[key] = data;
  return key;
}

const res = await fetch(HUB);
if (!res.ok) throw new Error(`hub data: ${res.status}`);
const projects = await res.json();
const overrides = Object.fromEntries(Object.entries(JSON.parse(await readFile("overrides.json", "utf8"))).map(([k, v]) => [k.toLowerCase(), v]));
const payloads = [];

for (const p of projects) {
  const repo = p.url.replace("https://github.com/", "");
  const o = overrides[repo.toLowerCase()] ?? {};
  if (o.exclude) continue;
  let icon; // one icon per project, looked up only if it has payloads
  // The hub only lists a pre-release when it is newer than the stable one
  for (const [channel, shown] of [["stable", p.stable], ["pre", p.pre]]) {
    if (!shown) continue;
    const rel = await gh(`/repos/${repo}/releases/tags/${encodeURIComponent(shown.tag)}`);
    if (!rel) continue; // version comes from a plain git tag, no release files
    const files = pickPayloads(repo, o, rel.assets);
    if (files.length && icon === undefined) icon = await iconKey(p, repo, o) ?? null;
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
        icon_key: icon ?? undefined,
      });
    }
    if (files.length) console.log(`${repo} ${channel} ${shown.tag}: ${files.map(a => a.name).join(", ")}`);
  }
}

// Never publish an empty source because of an upstream hiccup
if (!payloads.length) throw new Error("no payloads found");
await mkdir("dist", { recursive: true });
// Icons first, so the catalog never references a key that isn't published.
// "name" must come before "payloads" (Payload Manager parser requirement)
await writeFile("dist/icons.json", JSON.stringify({ icons }, null, 2) + "\n");
await writeFile("dist/payloads.json", JSON.stringify({ name: "PS5LinkCentalizer", icons_url: "icons.json", payloads }, null, 2) + "\n");
console.log(`${payloads.length} payloads, ${Object.keys(icons).length} icons`);

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
