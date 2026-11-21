# FastAPI on AWS Lambda through the Lambda Web Adapter (an extension that turns Lambda invocations into HTTP requests).
# Built for arm64 (Graviton) by CDK. The base image comes from the ECR Public mirror to avoid Docker Hub rate limits.
FROM public.ecr.aws/docker/library/python:3.13-slim

# The adapter runs next to the app and forwards each invocation to http://127.0.0.1:8080
COPY --from=public.ecr.aws/awsguru/aws-lambda-adapter:0.9.1 /lambda-adapter /opt/extensions/lambda-adapter

WORKDIR /var/task
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app

# Lambda runs the container as a non-root user by itself. Locally: docker run -p 8080:8080 <image>
CMD ["python", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080"]
