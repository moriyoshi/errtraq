# DuckDB runner for the M4d spike. Everything installs inside the image only.
FROM node:26.13.1-bookworm-slim
ARG DUCKDB_NODE_API_VERSION=2.0.1-r.1
WORKDIR /app
RUN echo '{"name":"runner","private":true,"type":"module"}' > package.json \
  && npm install --no-audit --no-fund @duckdb/node-api@${DUCKDB_NODE_API_VERSION}
# Scripts are mounted at /app/spike so module resolution finds /app/node_modules.
WORKDIR /app/spike
