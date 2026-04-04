# Build stage
FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ src/
RUN npm run build

# Runtime stage — non-root user (#15)
FROM node:20-alpine
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && chown -R appuser:appgroup /app
COPY --from=builder --chown=appuser:appgroup /app/dist/ dist/
COPY --chown=appuser:appgroup src/db/migrations/ src/db/migrations/
USER appuser
EXPOSE 3000
CMD ["node", "dist/api/server.js"]
