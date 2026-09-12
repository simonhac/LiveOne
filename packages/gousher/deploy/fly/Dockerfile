FROM golang:1.27-alpine AS build
WORKDIR /src
COPY packages/gousher/ ./
RUN CGO_ENABLED=0 go build -trimpath -o /out/gousher ./cmd/gousher && \
    CGO_ENABLED=0 go build -trimpath -o /out/trial-receiver ./cmd/trial-receiver && \
    CGO_ENABLED=0 go build -trimpath -o /out/trial-ops ./cmd/trial-ops
FROM alpine:3.22
RUN apk add --no-cache ca-certificates su-exec && adduser -D -u 10001 gousher
COPY --from=build /out/ /usr/local/bin/
COPY packages/gousher/deploy/fly/entrypoint.sh /usr/local/bin/trial-entrypoint
RUN chmod 755 /usr/local/bin/trial-entrypoint
ENTRYPOINT ["trial-entrypoint"]
CMD ["gousher", "-config", "/data/bootstrap.yaml"]
