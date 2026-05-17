# syntax=docker/dockerfile:1

# renovate: datasource=docker depName=oven/bun versioning=semver
ARG BUN_VERSION=1.3.13

FROM oven/bun:${BUN_VERSION} AS source
WORKDIR /app

COPY --link package.json README.md index.ts ./
COPY --link src ./src
COPY --link bench ./bench
COPY --link scripts ./scripts

FROM oven/bun:${BUN_VERSION} AS final
ENV NODE_ENV=production

COPY --link --from=source --chown=1000:1000 /app /app
WORKDIR /app
USER bun

ENTRYPOINT ["bun", "scripts/bench-compaction.ts"]
CMD ["--jsonl"]
