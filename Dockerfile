FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY server.js openapi.json ./
COPY public ./public
COPY test ./test
COPY db ./db
ENV PORT=4000
EXPOSE 4000
USER node
CMD ["node", "server.js"]
