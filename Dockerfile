FROM ghcr.io/puppeteer/puppeteer:23.11.1

WORKDIR /home/pptruser

COPY server.js /home/pptruser/server.js

EXPOSE 3000

CMD ["node", "server.js"]
