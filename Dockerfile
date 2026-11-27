FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev
COPY . .
RUN mkdir -p data
EXPOSE 3000
ENV NODE_ENV=production
CMD ["node", "server.js"]
