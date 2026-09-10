# ---- Creche Segura — imagem de produção ----
# Etapa 1: instala dependências e compila shared, server e web.
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --no-audit --no-fund --ignore-scripts
COPY tsconfig.base.json ./
COPY shared ./shared
COPY server ./server
COPY web ./web
RUN npm run build

# Etapa 2: imagem final enxuta, só com o que roda em produção.
FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY web/package.json web/
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
 && npm ci --omit=dev --no-audit --no-fund --ignore-scripts -w server -w shared \
 && apt-get purge -y python3 make g++ && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/shared/dist ./shared/dist
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/web/dist ./web/dist
ENV PORT=3000 HOST=0.0.0.0 DATA_DIR=/data WEB_DIST=/app/web/dist
VOLUME ["/data"]
EXPOSE 3000
USER node
CMD ["node", "server/dist/index.js"]
