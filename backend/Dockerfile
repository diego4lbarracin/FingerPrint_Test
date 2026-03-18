FROM golang:1.25 AS builder

WORKDIR /app

# Cache module download layer for faster rebuilds.
COPY go.mod go.sum ./
RUN go mod download

COPY . .

RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
    go build -trimpath -ldflags="-s -w" -o /out/fingerprint-backend .

FROM gcr.io/distroless/static-debian12:nonroot

WORKDIR /app

COPY --from=builder /out/fingerprint-backend /app/fingerprint-backend

ENV GIN_MODE=release
ENV PORT=4000

EXPOSE 4000

ENTRYPOINT ["/app/fingerprint-backend"]