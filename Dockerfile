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
COPY sqlite-amalgamation-3430200/ ./sqlite-amalgamation-3430200/

# Compile sqlite3 object
RUN gcc -c -O2 \
    sqlite-amalgamation-3430200/sqlite3.c \
    -o sqlite3.o

# Compile Database.cpp
RUN g++ -c -O2 -std=c++17 \
    -I./include \
    -I./sqlite-amalgamation-3430200 \
    src/Database.cpp \
    -o Database.o

# Compile main.cpp + link everything
RUN g++ -O2 -std=c++17 \
    -I./include \
    -I./sqlite-amalgamation-3430200 \
    src/main.cpp \
    Database.o sqlite3.o \
    -lpthread \
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
