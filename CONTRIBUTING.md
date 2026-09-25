# Contributing

## Development

Requirements:

- Node.js 20
- npm

Install and run:

```bash
npm ci
npm run dev
```

Before opening a pull request:

```bash
npm run lint
npm run build
```

## Changes

Prefer small, focused, testable changes. Keep authentication, uploads, AI integrations, and protected workspace operations explicit about their trust boundaries.

Do not commit:

- API keys
- access tokens
- service credentials
- private audio or transcript data
- generated build artifacts
