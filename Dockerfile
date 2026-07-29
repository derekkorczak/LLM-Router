# Stage 1: Build
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json .
RUN npm ci --only=production
COPY . .
RUN npm run build

# Stage 2: Runtime
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
EXPOSE 3000
CMD ["node", "dist/index.js"]