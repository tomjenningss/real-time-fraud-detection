FROM docker.io/library/golang:1.24-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/fraud-decision-engine ./cmd/engine

FROM docker.io/library/alpine:3.22
RUN addgroup -S engine && adduser -S -G engine engine
COPY --from=build /out/fraud-decision-engine /usr/local/bin/fraud-decision-engine
USER engine
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/fraud-decision-engine"]
