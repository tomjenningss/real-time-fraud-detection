FROM docker.io/library/golang:1.24-alpine AS build
WORKDIR /src
COPY go.mod ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/correlator ./cmd/correlator

FROM docker.io/library/alpine:3.22
RUN addgroup -S correlator && adduser -S -G correlator correlator
COPY --from=build /out/correlator /usr/local/bin/correlator
USER correlator
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/correlator"]
