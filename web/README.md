# web/ - the single-page app

React 19 + TypeScript, built with Vite. Plain CSS, no component library. Sign-in uses only the Auth module of AWS Amplify.

| Screen                   | What it does                                                                                                     |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| Sign in                  | email and password; an invited user's first sign-in asks for a new password                                      |
| Projects                 | list, create, delete                                                                                             |
| Project › Chats          | new chat (`basic` or `multi_query`), answers streamed as they are written, `[n]` markers linked to their sources |
| Project › Documents      | upload by picker or drag and drop, straight to S3; live status until `READY` or `FAILED`; delete                 |
| Project › Test retrieval | the passages a query returns, with scores. No model call                                                         |

## How it fits the deployment

- **One origin.** CloudFront serves the app and forwards `/api/*` to the API, so the app calls `/api`. No CORS for API calls.
- **No build-time configuration.** The app reads `/config.json` (region, Cognito ids, upload limits), which CDK writes at deploy time.
- **Uploads skip the API.** The browser posts the file to S3 with a presigned POST; the signed policy fixes key, type and size.
- **Streaming.** Answers are Server-Sent Events read over `fetch`, because `EventSource` cannot send the `Authorization` header.
- **Security.** The CSP allows scripts only from the app's origin (no inline scripts, no `eval`); the build is checked against it.
  Answers are rendered as text, never HTML. Amplify uses SRP, so the password is never sent. The API verifies every request.

## Files

| Path                     | Purpose                                                                                 |
| ------------------------ | --------------------------------------------------------------------------------------- |
| `src/lib/`               | configuration, API client, SSE reader, upload checks, router, citation parsing, sign-in |
| `src/components/`        | the screens                                                                             |
| `placeholder/index.html` | published when `dist/` does not exist, so CDK synth and tests work on a fresh clone     |
| `dist/`                  | the build. Generated, never committed                                                   |

## Commands

```bash
npm ci
npm run verify   # prettier, tsc (strict), vitest, production build (layer 10 of scripts/verify.sh)
npm run build    # writes dist/; infra's `npm run deploy` runs it for you
```

## Tests (49)

Stream reading with arbitrary chunk boundaries, the API client (token, sign-out on 401, which messages are shown, interrupted streams),
upload checks and S3 field order, routing, citations, config, polling. Component tests: a streamed answer with linked sources, a failed
answer (nothing kept, question restored), markup rendered as text, and first sign-in with a new password. Six deliberate faults were each caught.
