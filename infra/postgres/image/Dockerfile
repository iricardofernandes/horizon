# syntax=docker/dockerfile:1
#
# The platform's PostgreSQL: the same Alpine build it always ran, plus pgvector for the
# document index (ADR 0067, Phase 74). The official pgvector image is Debian; under glibc
# the cluster's en_US.utf8 would collate text differently from musl, silently invalidating
# every existing B-tree index on text. So the extension is compiled here instead.
FROM postgres:17-alpine@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73

ARG PGVECTOR_VERSION=v0.8.1

RUN apk add --no-cache --virtual .build-deps git build-base \
  && git clone --depth 1 --branch "${PGVECTOR_VERSION}" https://github.com/pgvector/pgvector.git /tmp/pgvector \
  && cd /tmp/pgvector \
  # No LLVM: the bitcode is only for JIT, which this cluster does not use.
  && make with_llvm=no OPTFLAGS="" \
  && make with_llvm=no install \
  && cd / && rm -rf /tmp/pgvector \
  && apk del .build-deps
