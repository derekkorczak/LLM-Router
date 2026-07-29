# Stage 1: Build Environment
FROM node:20-alpine AS builder
WORKDIR /app

# Copy package files
COPY package.json ./

# Install dependencies (use npm install since we don't have package-lock.json)
RUN npm install --production

# Install TypeScript for build
RUN npm install --save-dev typescript

# Copy source code
COPY . .

# Build the application
RUN npm run build

# Stage 2: Runtime Environment
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV CATALOG_DIR=/app/catalog

# Copy node_modules from builder
COPY --from=builder /app/node_modules ./node_modules

# Copy built files
COPY --from=builder /app/dist ./dist

# Copy config file
COPY --from=builder /app/router.config.json ./router.config.json

# Create catalog directory
RUN mkdir -p /app/catalog

EXPOSE 3000
CMD ["node", "dist/index.js"]
