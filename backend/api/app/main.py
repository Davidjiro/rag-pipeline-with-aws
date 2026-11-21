"""PLACEHOLDER API.

This file exists so the infrastructure stage can build and deploy a real container. It only answers the health check that the
Lambda Web Adapter uses to know the app is ready. The real routes (projects, files, chats, streaming answers) are implemented
in the backend stage. All routes live under /api because CloudFront forwards the path unchanged.
"""

from fastapi import APIRouter, FastAPI

app = FastAPI(title="Bedrock Knowledge Chat API", docs_url=None, redoc_url=None, openapi_url=None)
router = APIRouter(prefix="/api")


@router.get("/health")
def health() -> dict:
    """Unauthenticated liveness check, also used as the Lambda Web Adapter readiness check."""
    return {"status": "ok", "stage": "placeholder"}


app.include_router(router)
