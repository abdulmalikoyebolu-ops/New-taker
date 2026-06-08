FROM node:18-bullseye-slim

RUN apt-get update && apt-get install -y \
    git \
    ca-certificates \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

ENV PORT=3000
ENV NODE_ENV=production

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .

EXPOSE 3000

CMD ["node", "index.js"]
