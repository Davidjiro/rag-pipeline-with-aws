# agent/app/  -  the agent package

Placeholder in the infrastructure stage: `main.py` serves `GET /ping` and `POST /invocations` with `http.server`, so the container needs no
dependencies. The real agent (Strands, tools, prompts, citations) replaces it in the agent stage.
