# ── Stage 1: install dependencies ────────────────────────────────────────────
FROM node:20-slim AS builder
WORKDIR /app
COPY package.json .
RUN npm install --omit=dev

# ── Stage 2: lean runtime image ───────────────────────────────────────────────
FROM node:20-slim
RUN useradd --create-home appuser
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY package.json app.js ./
USER appuser
ENV PORT=8080
EXPOSE 8080
CMD ["node", "app.js"]
