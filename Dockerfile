# Stage 1: Build Environment
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json .
RUN npm ci --only=production --no-audit
COPY . .
RUN npm run build

# Stage 2: Runtime Environment
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV CATALOG_DIR=/app/catalog

# Copy built files from builder stage
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
EXPOSE 3000
CMD ["node", "dist/index.js"]