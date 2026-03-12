# OpenClaw Feishu Plugin

Standalone source repository for the OpenClaw Feishu/Lark channel plugin.

This repository is the source of truth for the Feishu plugin code that currently
also runs on the local OpenClaw installation.

## What is included

- Feishu/Lark channel implementation
- doc/wiki/drive/bitable/perm tools
- group collaboration arbitration and reply sanitization tests
- plugin metadata for OpenClaw discovery

## Repository layout

- `index.ts`: plugin entrypoint
- `openclaw.plugin.json`: plugin manifest
- `src/`: runtime and tests
- `skills/`: plugin-provided skills
- `scripts/sync-to-installed-extension.sh`: sync this repo into the local installed plugin path

## Local development

Install dependencies:

```bash
npm install
```

Run tests:

```bash
npm test
```

Sync this repository to the local installed OpenClaw plugin:

```bash
npm run sync:local
```

## Runtime note

The local OpenClaw installation still loads the plugin from:

```text
/home/oppo/.nvm/versions/node/v22.22.0/lib/node_modules/openclaw/extensions/feishu
```

This repository does not replace that path automatically. Use the sync script to
push repository changes into the installed runtime.

## Compatibility

- Plugin source baseline: `@openclaw/feishu@2026.3.8-beta.1`
- Host runtime target: `openclaw@2026.3.8`
