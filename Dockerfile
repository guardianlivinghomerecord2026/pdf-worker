FROM mcr.microsoft.com/playwright:v1.42.0-jammy

WORKDIR /app

# copy only package first (forces clean install layer)
COPY package.json ./

# install dependencies clean
RUN npm install

# now copy rest of app
COPY . .

CMD ["node", "pdfWorker.js"]
