# Transcript.art Architecture

Transcript.art is a browser-first application organized around a React/Vite frontend with feature modules for transcription, audio capture, AI assistance, exports, billing/access workflows, and protected workspaces.

## High-level flow

```text
Browser
  |
  +--> React application
  |      |
  |      +--> transcription session workspace
  |      +--> audio upload / browser capture
  |      +--> AI assistant / AI studio
  |      +--> translation and transcript cleanup
  |      +--> exports and PWA support
  |
  +--> authenticated protected workspaces
  |
  +--> server/integration layer
          |
          +--> authentication
          +--> persistence
          +--> AI/search providers
          +--> file storage
```

## Trust boundaries

1. **Browser boundary** — UI state and user-controlled input are untrusted.
2. **Authentication boundary** — protected routes must verify identity server-side.
3. **Integration boundary** — provider calls must not expose secrets to the browser.
4. **File boundary** — uploaded audio and generated documents can contain sensitive information.
5. **AI boundary** — prompts and retrieved context should be treated as untrusted input.

## Repository quality

CI runs dependency installation from `package-lock.json`, linting, and a production build. Dependency updates are automated through Dependabot.

## Deployment

The repository is intended to build as a Vite static application. Hosting-specific environment variables should be configured in the deployment platform rather than committed to source.
