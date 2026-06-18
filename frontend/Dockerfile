# Multi-stage build for the React/Vite frontend served by nginx.

FROM node:24-alpine AS build
WORKDIR /src
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi
COPY . .
RUN npm run build

FROM nginx:1.27-alpine AS runtime
# The default nginx image entrypoint expands env vars in
# /etc/nginx/templates/*.conf.template using envsubst at container start.
COPY nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /src/dist /usr/share/nginx/html

ENV PROXY_URL=http://127.0.0.1:8090
ENV EVAL_URL=http://127.0.0.1:8099
EXPOSE 8080
CMD ["nginx", "-g", "daemon off;"]
