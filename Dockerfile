FROM ghcr.io/puppeteer/puppeteer:24.34.0

USER root

# Setup workspace and entrypoint
WORKDIR /app

# Ensure we have a place for fonts that the user can write to if needed, 
# though system fonts are usually root. 
# We will use /home/pptruser/.fonts for user-level fonts via entrypoint.
RUN mkdir -p /home/pptruser/.fonts \
    && chown -R pptruser:pptruser /home/pptruser/.fonts

# Copy application files
COPY package.json .
RUN npm install

COPY server.js .
COPY entrypoint.sh .
RUN chmod +x entrypoint.sh

# Fix permissions for /app
RUN chown -R pptruser:pptruser /app

# Switch back to non-root user
USER pptruser

ENV PORT=3000
ENV CONCURRENCY_LIMIT=5
ENV ERROR_RESTART_THRESHOLD=5
ENV ERROR_RESET_THRESHOLD=3

EXPOSE 3000

# Use the entrypoint script to handle dynamic font loading
ENTRYPOINT ["./entrypoint.sh"]
