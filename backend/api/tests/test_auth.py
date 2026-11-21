"""Token verification: every rejection path, and the one accepted path."""

from __future__ import annotations

import time
from types import SimpleNamespace

import jwt
import pytest
from app import auth
from app.config import get_settings
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import HTTPException
from jwt.exceptions import PyJWKClientConnectionError, PyJWKClientError

KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
OTHER_KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)


class FakeKeys:
    def __init__(self, error: Exception | None = None):
        self.error = error

    def get_signing_key_from_jwt(self, token):
        if self.error:
            raise self.error
        return SimpleNamespace(key=KEY.public_key())


def make_token(**overrides) -> str:
    settings = get_settings()
    claims = {
        "sub": "user-123",
        "iss": settings.issuer,
        "token_use": "access",
        "client_id": settings.cognito_client_id,
        "exp": int(time.time()) + 600,
    }
    claims.update({k: v for k, v in overrides.items() if k != "_key"})
    claims = {k: v for k, v in claims.items() if v is not None}
    return jwt.encode(claims, overrides.get("_key", KEY), algorithm="RS256")


def verify(token: str, keys=None) -> str:
    return auth.verify_token(token, get_settings(), keys or FakeKeys())


def test_valid_access_token_returns_sub(environment):
    assert verify(make_token()) == "user-123"


@pytest.mark.parametrize(
    "overrides",
    [
        {"exp": int(time.time()) - 3600},  # expired
        {"iss": "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_OTHER"},  # another pool
        {"token_use": "id"},  # ID token instead of access token
        {"client_id": "someone-elses-client"},  # another app client
        {"sub": None},  # no subject
        {"exp": None},  # no expiry
        {"_key": OTHER_KEY},  # signed with a different key
    ],
    ids=["expired", "wrong-issuer", "id-token", "wrong-client", "no-sub", "no-exp", "bad-signature"],
)
def test_rejected_tokens(environment, overrides):
    with pytest.raises(HTTPException) as caught:
        verify(make_token(**overrides))
    assert caught.value.status_code == 401


def test_unsigned_token_is_rejected(environment):
    token = jwt.encode({"sub": "x"}, key="", algorithm="none")
    with pytest.raises(HTTPException) as caught:
        verify(token)
    assert caught.value.status_code == 401


def test_hs256_token_signed_with_public_key_is_rejected(environment):
    """The classic algorithm-confusion attack: only RS256 is accepted."""
    token = jwt.encode({"sub": "x", "exp": int(time.time()) + 60}, "secret-secret-secret-secret-1234", algorithm="HS256")
    with pytest.raises(HTTPException) as caught:
        verify(token)
    assert caught.value.status_code == 401


def test_unknown_key_id_is_401(environment):
    with pytest.raises(HTTPException) as caught:
        verify(make_token(), FakeKeys(PyJWKClientError("kid not found")))
    assert caught.value.status_code == 401


def test_unreachable_key_set_is_503(environment):
    with pytest.raises(HTTPException) as caught:
        verify(make_token(), FakeKeys(PyJWKClientConnectionError("down")))
    assert caught.value.status_code == 503


def test_garbage_token_is_401(environment):
    with pytest.raises(HTTPException) as caught:
        verify("not.a.jwt", FakeKeys(PyJWKClientError("bad")))
    assert caught.value.status_code == 401


def test_route_requires_bearer_header(aws):
    from app.main import app
    from fastapi.testclient import TestClient

    client = TestClient(app)
    assert client.get("/api/projects").status_code == 401
    assert client.get("/api/projects", headers={"Authorization": "Basic abc"}).status_code == 401
    assert client.get("/api/projects", headers={"Authorization": "Bearer "}).status_code == 401
    assert client.get("/api/health").status_code == 200
