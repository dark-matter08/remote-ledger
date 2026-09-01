# Playwright base = Node 20 + Chromium + all system deps (for resume PDF rendering).
FROM mcr.microsoft.com/playwright:v1.60.0-jammy

WORKDIR /app

# install deps (no native modules — SQLite is built into Node)
COPY package.json package-lock.json ./
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=0
RUN npm ci || npm install

COPY . .
RUN npm run build

ENV NODE_ENV=production
ENV PORT=5173
EXPOSE 5173

# data/ (DB, PDFs, encrypted keys) should be a mounted volume — see docker-compose.yml
CMD ["npm", "run", "start"]
