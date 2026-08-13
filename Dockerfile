FROM node:8 AS build

WORKDIR /app

COPY package*.json /app/
RUN git config --global url.https://github.com/.insteadOf git://github.com/ && npm install

COPY . /app
RUN npm run build:web && \
    sed -i 's/src=web.js/src=web.js?v=20260813-15-tts-speed/' /app/dist/web/index.html

FROM nginx:alpine

COPY --from=build --chown=nginx:nginx /app/dist/web /usr/share/nginx/html

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
