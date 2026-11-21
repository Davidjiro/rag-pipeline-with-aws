# backend/api/  -  FastAPI on Lambda (placeholder)

A container image: Python 3.13, FastAPI, and the **Lambda Web Adapter** extension, which turns each Lambda invocation into a normal HTTP request
to the app on the container's port 8080. The same app runs locally. The Function URL streams responses (`AWS_LWA_INVOKE_MODE=response_stream`).

| File | Purpose |
|------|---------|
| `Dockerfile` | arm64 image, adapter extension `0.9.1`, base image from the ECR Public mirror (avoids Docker Hub rate limits) |
| `requirements.txt` | pinned dependencies |
| `app/main.py` | **placeholder**: `GET /api/health` only. Swagger and OpenAPI are switched off |

## Conventions the real implementation must keep

- Every route lives under `/api`, because CloudFront forwards the path unchanged.
- Every route except `/api/health` requires a valid Cognito JWT (signature, issuer, expiry, token type, client id), and checks that the user owns the project it touches.
- Streaming answers start with a keep-alive line immediately, because CloudFront waits at most 60 seconds for the next byte.

## Check it locally

```bash
docker build --platform linux/arm64 -t kc-api backend/api
```

The adapter only activates inside Lambda. To exercise the app without it, run the app module directly with uvicorn.
