"""Unauthenticated liveness check. The Lambda Web Adapter polls it to learn the app is ready."""

from fastapi import APIRouter

router = APIRouter()


@router.get("/health")
def health() -> dict:
    return {"status": "ok"}
