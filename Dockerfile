FROM mcr.microsoft.com/playwright:v1.42.0-jammy

WORKDIR /app

# Copy everything first (ensures package.json is present)
COPY . .

# Install dependencies AFTER copy
RUN npm install

ENV NODE_ENV=production

CMD ["node", "pdfWorker.js"]
