# ── SDCMS Backend Dockerfile ──────────────────────────────────────────────────
# Multi-stage: Build C++ binary → minimal runtime image

# ── Stage 1: Build ────────────────────────────────────────────────────────────
FROM gcc:13 AS builder

WORKDIR /build

# Install SQLite3 dev headers
RUN apt-get update && apt-get install -y libsqlite3-dev && rm -rf /var/lib/apt/lists/*

# Copy source files
COPY src/            ./src/
COPY include/        ./include/

# Compile sqlite3 object
RUN gcc -c -O2 \
    src/sqlite3.c \
    -I./include \
    -o sqlite3.o

# Compile Database.cpp
RUN g++ -c -O2 -std=c++17 \
    -I./include \
    src/Database.cpp \
    -o Database.o

# Compile main.cpp + link everything
RUN g++ -O2 -std=c++17 \
    -I./include \
    src/main.cpp \
    Database.o sqlite3.o \
    -lpthread \
    -static-libstdc++ -static-libgcc \
    -o sdcms_server

# ── Stage 2: Runtime ──────────────────────────────────────────────────────────
FROM debian:bookworm-slim

WORKDIR /app

# Copy compiled binary
COPY --from=builder /build/sdcms_server ./sdcms_server

# Port used by the server
EXPOSE 8080

# Run the server
CMD ["./sdcms_server"]
