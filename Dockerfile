FROM node:16
WORKDIR /app
COPY . .
RUN npm install
EXPOSE 27017
CMD ["npm", "run", "start"]