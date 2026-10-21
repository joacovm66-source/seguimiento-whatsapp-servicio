FROM node:22-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .
ENV DATA_DIR=/tmp/datos CLOUD_STATE=1
CMD ["node", "puente.js"]
