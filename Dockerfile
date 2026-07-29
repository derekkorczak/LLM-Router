# Stage 1: Build Environment
FROM node:20-alpine AS builder
WORKDIR /app
RUN apk add --no-cache curl && 
    curl -sL https://raw.githubusercontent.com/npm/cli/master/bin/install.sh | bash && 
    npm install --only=production --no-fund --no-audit --verbose && 
    echo "Dependencies installed" && 
    COPY package.json .
    COPY package-lock.json .
    COPY . .
    npm run build

# Stage 2: Runtime Environment
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV CATALOG_DIR=/app/catalog
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
EXPOSE 3000
CMD ["node", "dist/index.js"]
