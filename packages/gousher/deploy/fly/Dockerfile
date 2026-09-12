FROM golang:1.27-alpine AS build
WORKDIR /src
COPY packages/gousher/ ./
RUN CGO_ENABLED=0 go build -trimpath -o /out/gousher ./cmd/gousher && \
    CGO_ENABLED=0 go build -trimpath -o /out/trial-receiver ./cmd/trial-receiver
FROM alpine:3.22
RUN apk add --no-cache ca-certificates && adduser -D -u 10001 gousher
COPY --from=build /out/ /usr/local/bin/
USER gousher
ENTRYPOINT ["gousher"]
CMD ["-config", "/data/bootstrap.yaml"]
