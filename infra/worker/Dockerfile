FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY mz_worker ./mz_worker
RUN useradd -r -u 10001 worker
USER worker
STOPSIGNAL SIGTERM
CMD ["python", "-m", "mz_worker"]
