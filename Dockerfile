# نظام طلبات العملاء - للتشغيل على Railway أو أي استضافة Docker
FROM node:22-alpine
RUN apk add --no-cache tzdata
ENV NODE_ENV=production TZ=Africa/Cairo
WORKDIR /app
COPY orders-system/ ./
EXPOSE 3000
HEALTHCHECK --interval=60s --timeout=5s CMD wget -qO- http://127.0.0.1:${PORT:-3000}/healthz || exit 1
CMD ["node", "server.js"]
