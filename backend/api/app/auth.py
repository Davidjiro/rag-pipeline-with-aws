"""Verify the Cognito access token on every request.

The API Function URL is public (CloudFront is the front door), so this module is the authentication boundary. The checks:

    signature   RS256 against the user pool's published keys (JWKS), fetched once and cached
    iss         exactly this user pool
    exp         present and not expired (30 s clock-skew leeway)
    token_use   must be "access" (an ID token is refused)
    client_id   must be this app client (a token for another client in the pool is refused)
    sub         present. It is the user id used in every DynamoDB key.

Failures return 401 with a generic message. If the key set cannot be fetched the API returns 503, because that is a server-side
problem and a retry may succeed.
"""

from __future__ import annotations

import logging
from functools import lru_cache
from typing import Any

import jwt
from fastapi import HTTPException, Request
from jwt import PyJWKClient
from jwt.exceptions import PyJWKClientConnectionError

from .config import Settings, get_settings

log = logging.getLogger(__name__)

_REQUIRED = ["exp", "iss", "sub", "token_use", "client_id"]


@lru_cache
def jwk_client() -> PyJWKClient:
    """One key-set client per container. Keys are cached for an hour and refetched when an unknown key id appears."""
    return PyJWKClient(get_settings().jwks_url, cache_keys=True, lifespan=3600, timeout=5)


def verify_token(token: str, settings: Settings, keys: Any) -> str:
    """Return the user id (`sub`) of a valid token. Raises HTTPException 401 or 503."""
    unauthorized = HTTPException(status_code=401, detail="Invalid or expired token.", headers={"WWW-Authenticate": "Bearer"})
    try:
        signing_key = keys.get_signing_key_from_jwt(token)
        claims = jwt.decode(
            token,
            signing_key.key,
            algorithms=["RS256"],
            issuer=settings.issuer,
            leeway=30,
            options={"require": _REQUIRED, "verify_aud": False},
        )
    except PyJWKClientConnectionError as exc:
        log.error("Cannot fetch the signing keys: %s", exc)
        raise HTTPException(status_code=503, detail="Authentication service unavailable. Try again.") from exc
    except jwt.PyJWTError as exc:
        log.info("Token rejected: %s", type(exc).__name__)
        raise unauthorized from exc

    if claims["token_use"] != "access" or claims["client_id"] != settings.cognito_client_id or not claims["sub"]:  # noqa: S105 (a claim name, not a password)
        log.info("Token rejected: wrong token_use or client_id")
        raise unauthorized
    return str(claims["sub"])


def current_user(request: Request) -> str:
    """FastAPI dependency: the authenticated user id, from the `Authorization: Bearer <token>` header."""
    header = request.headers.get("authorization", "")
    scheme, _, token = header.partition(" ")
    if scheme.lower() != "bearer" or not token.strip():
        raise HTTPException(status_code=401, detail="Missing bearer token.", headers={"WWW-Authenticate": "Bearer"})
    return verify_token(token.strip(), get_settings(), jwk_client())
