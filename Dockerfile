FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
# La carte (plusieurs Go) n'est pas dans l'image : elle est téléchargée dans un volume par le service « carte »
ENV PORT=3000 DATA_DIR=/data MAP_FILE=/carte/carte.pmtiles NODE_ENV=production
# Dossiers appartenant à l'utilisateur non privilégié : un volume neuf hérite de ces droits
RUN mkdir -p /data /carte && chown node:node /data /carte
VOLUME /data
EXPOSE 3000
USER node
CMD ["node", "server.js"]
