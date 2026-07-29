# Stage 1: Build Environment
FROM node:20-alpine AS builder
WORKDIR /app

# Copy package files
COPY package.json ./package.json
COPY package-lock.json ./package-lock.json

# Install all dependencies (including dev for TypeScript build)
RUN npm install

# Copy source code and config
COPY tsconfig.json ./
COPY router.config.json ./
COPY src/ ./src/

# Build the application
RUN npm run build

# Prune dev dependencies for production
RUN npm prune --production

# Stage 2: Runtime Environment
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV CATALOG_DIR=/app/catalog

# Copy production node_modules from builder
COPY --from=builder /app/node_modules ./node_modules

# Copy built files
COPY --from=builder /app/dist ./dist

# Copy config file
COPY --from=builder /app/router.config.json ./router.config.json

# Create catalog directory
RUN mkdir -p /app/catalog

EXPOSE 3000

CMD ["node", "dist/index.js"]
