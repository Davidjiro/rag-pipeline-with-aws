"""FastAPI application: assembles the routers and maps dependency failures to HTTP errors.

Runs on AWS Lambda behind the Lambda Web Adapter, which forwards each invocation to this server on port 8080 and streams the
response back. All routes live under /api because CloudFront forwards the path unchanged. Interactive docs are disabled.
"""

from __future__ import annotations

import logging

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from .kb import KnowledgeBaseError
from .routes import chats, files, health, projects, retrieve

logging.getLogger().setLevel(logging.INFO)
log = logging.getLogger(__name__)

app = FastAPI(title="Bedrock Knowledge Chat API", docs_url=None, redoc_url=None, openapi_url=None)

for module in (health, projects, files, chats, retrieve):
    app.include_router(module.router, prefix="/api")


@app.exception_handler(KnowledgeBaseError)
async def knowledge_base_error(_: Request, exc: KnowledgeBaseError) -> JSONResponse:
    """A Knowledge Base call failed. The cause is logged; the caller gets a generic, retryable error."""
    log.error("Knowledge Base error: %s", exc)
    return JSONResponse(status_code=502, content={"detail": "The knowledge base is unavailable. Please try again."})
