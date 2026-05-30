FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY steam-monitor.js ./

CMD ["node", "steam-monitor.js"]
