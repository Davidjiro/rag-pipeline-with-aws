# backend/api/app/  -  the API package

Placeholder in the infrastructure stage: `main.py` exposes `GET /api/health`, used by the Lambda Web Adapter as its readiness check
(`AWS_LWA_READINESS_CHECK_PATH`). The real routers (projects, files, chats, streaming answers) are added in the backend stage.
