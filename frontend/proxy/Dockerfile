FROM node:24-alpine AS build
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.mjs ./

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production \
    PROXY_PORT=8090 \
    PROXY_HOST=0.0.0.0
COPY --from=build /app /app
EXPOSE 8090
USER node
CMD ["node", "server.mjs"]
