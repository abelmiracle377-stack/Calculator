# Transcript.art

**Transcript.art** is the application repository behind the Transcript.art web experience. It is a browser-first AI transcription and productivity workspace with audio capture, transcription, translation, transcript cleanup, exports, AI assistance, and protected workspace features.

## Core capabilities

- Audio upload and browser capture workflows
- Transcription session management
- Transcript review and cleanup
- Translation workflows
- AI assistant and AI Studio features
- Export to document-oriented formats
- Installable PWA support
- Protected administrative and security workspace routes
- Authentication and access-control integrations

## Stack

- React 18
- TypeScript
- Vite
- Tailwind CSS
- shadcn/Radix UI components
- TanStack Query
- React Router
- Recharts
- Framer Motion
- Zod
- npm lockfile

## Local development

Requires Node.js 20 and npm.

```bash
npm ci
npm run dev
```

Production checks:

```bash
npm run lint
npm run build
```

## Project structure

```text
src/
├── components/       UI and feature components
├── entities/         domain models
├── functions/        application/server integration functions
├── hooks/            reusable browser hooks
├── integrations/     external service integrations
├── lib/              transcription, learning, billing and utility logic
└── pages/            application routes
```

## Security

See [SECURITY.md](SECURITY.md) and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

Never commit credentials, private audio, transcript data, API keys, or service-role secrets.

## CI

Every pull request targeting `main` runs:

1. `npm ci`
2. ESLint
3. Production Vite build

Dependabot checks npm and GitHub Actions dependencies on a scheduled basis.

## Product relationship

This repository is the application code associated with **Transcript.art**. Existing hosting/provider integration hooks are intentionally preserved; change them only together with the corresponding deployment configuration.
