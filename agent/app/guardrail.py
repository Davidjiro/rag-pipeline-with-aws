"""Check the user's text against the Bedrock guardrail (prompt-attack filter) before any model call.

`ApplyGuardrail` is called directly on the user's own text only, once per question. Calling it through the model instead would
bill every model turn, including tool results. If the check cannot run, the question is refused: failing open would let an
unchecked prompt through.
"""

from __future__ import annotations

import logging
from typing import Any

from botocore.exceptions import BotoCoreError, ClientError

log = logging.getLogger(__name__)


class GuardrailError(Exception):
    """The guardrail could not be evaluated."""


class InputGuardrail:
    def __init__(self, client: Any, guardrail_id: str, version: str) -> None:
        self._client = client
        self._id = guardrail_id
        self._version = version

    def blocks(self, text: str) -> bool:
        """True if the guardrail intervenes. Raises GuardrailError if it cannot decide."""
        try:
            response = self._client.apply_guardrail(
                guardrailIdentifier=self._id,
                guardrailVersion=self._version,
                source="INPUT",
                content=[{"text": {"text": text}}],
            )
        except (ClientError, BotoCoreError) as exc:
            raise GuardrailError(f"ApplyGuardrail failed: {exc}") from exc
        return response.get("action") == "GUARDRAIL_INTERVENED"
