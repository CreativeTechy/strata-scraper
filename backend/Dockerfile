# syntax=docker/dockerfile:1.7
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app/backend

COPY requirements.txt ./requirements.txt

# Every dependency (lxml, psycopg[binary], uvicorn's standard extras) ships a
# manylinux wheel, so there is no compiler step here. Installing
# build-essential and the libxml2/libxslt/ffi/ssl headers "to be safe" cost
# ~94 MB of apt downloads and 380 MB on disk per build - on a slow Debian
# mirror that alone ran 15+ minutes and made `docker compose up --build` look
# hung. --only-binary=:all: keeps it that way: a dependency that starts
# shipping only an sdist fails the build loudly here instead of silently
# needing a toolchain back.
RUN --mount=type=cache,target=/root/.cache/pip \
    python -m pip install --upgrade pip setuptools wheel && \
    python -m pip install --only-binary=:all: -r requirements.txt

COPY . .

RUN mkdir -p /app/storage

EXPOSE 8000

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
