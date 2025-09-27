# -------- deps --------
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json yarn.lock ./
RUN corepack enable && yarn install --frozen-lockfile

# -------- build --------
FROM node:20-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN yarn build

# -------- runtime --------
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
# Cloud Run injects PORT at runtime; default to 8080 for local runs
ENV PORT=8080
COPY --from=build /app/dist ./dist
COPY --from=deps  /app/node_modules ./node_modules
EXPOSE 8080
CMD ["node", "dist/index.js"]
