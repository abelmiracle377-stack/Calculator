# Security Policy

## Scope

Transcript.art is a web application containing transcription, AI-assisted workflows, browser audio capture, authentication, and protected workspace features.

## Reporting a vulnerability

Do not disclose credentials, private keys, access tokens, personal data, or exploit details in a public issue.

For a suspected security vulnerability, contact the project owner privately through the repository's GitHub security reporting channel when available. Include:

- affected route, component, or workflow
- reproducible steps
- expected versus actual behavior
- impact
- relevant logs without secrets

## Security principles

- Secrets must remain in environment variables or the hosting provider's secret store.
- Browser code must never contain service-role credentials.
- Protected server actions must enforce authorization independently of UI visibility.
- Uploaded audio and transcript data should be treated as potentially sensitive.
- Third-party AI/search integrations should receive only the minimum data required.
- Production builds should be generated from the lockfile with `npm ci`.

Automated CI and static checks do not constitute an independent security audit.
