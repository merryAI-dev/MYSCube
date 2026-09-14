FROM python:3.13-slim-bookworm
RUN pip install --no-cache-dir uv==0.11.6
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/hermes
RUN git init . && git remote add origin https://github.com/nousresearch/hermes-agent.git && \
    git fetch --depth 1 origin 939e45c91d751fadd94dcd1b873ac3cb44846213 && \
    git checkout --detach FETCH_HEAD && \
    test "$(git rev-parse HEAD)" = "939e45c91d751fadd94dcd1b873ac3cb44846213" && \
    uv sync --frozen --no-dev
RUN useradd --uid 10001 --create-home harness
COPY server/hermes/harness.py server/hermes/service.py server/hermes/test_harness.py server/hermes/test_service.py /app/
ENV PATH="/opt/hermes/.venv/bin:$PATH" PYTHONPATH="/opt/hermes" PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
USER 10001
WORKDIR /app
EXPOSE 8080
CMD ["python", "/app/service.py"]
