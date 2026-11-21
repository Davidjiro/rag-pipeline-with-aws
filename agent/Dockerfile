# Chat agent container for Amazon Bedrock AgentCore Runtime. AgentCore runs ARM64 containers and talks to them on port 8080:
#   POST /invocations   the request
#   GET  /ping          health check
FROM public.ecr.aws/docker/library/python:3.13-slim

ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
WORKDIR /app
COPY app ./app

# Run as a non-root user.
RUN useradd --uid 10001 --create-home agent
USER agent

EXPOSE 8080
CMD ["python", "-m", "app.main"]
