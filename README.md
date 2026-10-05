# PS5 Payloads Source

[PS5 Payload Manager](https://github.com/itsPLK/ps5-payload-manager) source built from the [PS5LinkCentalizer](https://github.com/pedrohti/PS5LinkCentalizer) project list.

## Use it

In PS5 Payload Manager → Settings → Manage Sources → Add Source:

```
https://gh.phm.tec.br/ps5-payloads-source/payloads.json
```

## How it works

- `.github/workflows/build.yml` runs every 6h (30 min after the hub refreshes), on push and on demand.
- It reads the hub's `data.json`, takes each project's stable version (or the pre-release when there is no stable one), and lists the console payload files (`.elf`, `.bin`, `.lua`) attached to that release.
- Links point straight to the original GitHub release; nothing is re-hosted. The SHA-256 comes from GitHub when available, so the manager verifies each download.
- Files are saved as `Name_version.elf`, which is how the manager detects updates (same scheme as the itsPLK mirror, so payloads installed from it show updates here too).
- Projects that go offline leave the hub's list, so they disappear from here automatically.
- Payloads only published inside a `.zip` are not included (the manager can't extract them).
- Result is deployed to GitHub Pages; the repo itself never gets bot commits.

## Overrides

`overrides.json`, keyed by `owner/repo`:

- `"payload"`: glob (or list of globs) picking the file(s) when a release ships more than one payload. Several matches become several entries.
- `"exclude": true`: leave the project out.

```json
{ "drakmor/nanoDNS": { "payload": "nanodns.elf" } }
```

To add a project, add it to the [hub](https://github.com/pedrohti/PS5LinkCentalizer#add-a-project); it shows up here on the next run.

Local: `node scripts/build.mjs` (Node 20+) writes `dist/payloads.json`. Set `GITHUB_TOKEN` to avoid the 60 req/h limit.

## Disclaimer

This is only an index of links to third-party releases. Not affiliated with, and not responsible for, any listed payload: all belong to their respective authors and are used at your own risk. Running homebrew or jailbreak software may violate your console's terms of service and local laws. If you are the author of a listed payload and want it removed, open an issue.

## AI usage

Built with the help of AI (Claude Code) to speed up production. All code was reviewed and is maintained by me; issues and PRs with improvements are welcome.

## License

[MIT](LICENSE)
