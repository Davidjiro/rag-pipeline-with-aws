"""PLACEHOLDER agent.

Implements only the HTTP contract of AgentCore Runtime with the standard library, so the container builds without any
dependency and the runtime can be created and invoked in the infrastructure stage:

    GET  /ping          -> {"status": "Healthy"}
    POST /invocations   -> a fixed JSON reply

The real agent (Strands + Bedrock model + guardrail + Knowledge Base search tool, streaming answers and citations) is
implemented in the agent stage.
"""

import json
from http.server import BaseHTTPRequestHandler, HTTPServer


class Handler(BaseHTTPRequestHandler):
    def _send(self, status: int, body: dict) -> None:
        data = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self) -> None:  # noqa: N802 (name fixed by BaseHTTPRequestHandler)
        if self.path == "/ping":
            self._send(200, {"status": "Healthy"})
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self) -> None:  # noqa: N802
        if self.path == "/invocations":
            length = int(self.headers.get("Content-Length", "0"))
            self.rfile.read(length)  # the request is ignored by the placeholder
            self._send(200, {"answer": "placeholder agent: not implemented yet", "citations": []})
        else:
            self._send(404, {"error": "not found"})

    def log_message(self, format: str, *args) -> None:  # noqa: A002
        return  # keep logs quiet


if __name__ == "__main__":
    HTTPServer(("0.0.0.0", 8080), Handler).serve_forever()
