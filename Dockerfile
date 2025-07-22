# WALLET‑WATCHER/Dockerfile
FROM node:20-alpine

# 1) Install production dependencies
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

# 2) Copy source
COPY . .

# 3) Run
EXPOSE 3000
CMD ["node", "server.js"]