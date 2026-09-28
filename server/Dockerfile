FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

COPY requirements-prod.txt ./
RUN pip install --no-cache-dir -r requirements-prod.txt

COPY main.py ./
COPY bootstrap_admin.py ./
COPY templates ./templates

RUN useradd --system --uid 10001 hedge && mkdir -p /data /downloads /updates && chown hedge:hedge /data
USER hedge

EXPOSE 8000
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--forwarded-allow-ips", "*"]
