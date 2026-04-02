FROM node:20-alpine

WORKDIR /app

# Install all dependencies (including dev for prisma CLI)
COPY package*.json ./
RUN npm install

# Copy prisma schema + config and generate client
COPY prisma ./prisma/
COPY prisma.config.ts ./
RUN npx prisma generate

# Copy application code
COPY . .

# Create uploads and data directories
RUN mkdir -p uploads data

EXPOSE 6565

# Sync schema and start server
CMD ["sh", "-c", "npx prisma db push && node server.js"]
