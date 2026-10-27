FROM node:22-slim
WORKDIR /app
COPY . .
ENV NODE_ENV=production
ENV DATABASE_PATH=/data/holdline.db
VOLUME /data
EXPOSE 3000
CMD ["node", "src/server.js"]
