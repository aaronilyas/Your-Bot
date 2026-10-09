FROM ubuntu:24.04 AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates xvfb xauth libgtk-3-0 libnss3 libatk-bridge2.0-0 \
    libdrm2 libxkbcommon0 libgbm1 libasound2t64 libxshmfence1 libx11-xcb1 \
    libxss1 python3 python3-venv bubblewrap gcc libc6-dev \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 1001 desktop-test
FROM runtime
COPY apps/desktop/release/linux-unpacked/ /opt/your-bot/
COPY tests/desktop-smoke.mjs /validation/desktop-smoke.mjs
COPY .validation/default_app.asar /opt/your-bot/resources/default_app.asar
RUN chown root:root /opt/your-bot/chrome-sandbox && chmod 4755 /opt/your-bot/chrome-sandbox \
    && mv /opt/your-bot/resources/app.asar /validation/application.asar
USER desktop-test
ENV HOME=/home/desktop-test
CMD ["sh", "-c", "xvfb-run -a /opt/your-bot/your-bot /validation/desktop-smoke.mjs && xvfb-run -a /opt/your-bot/your-bot /validation/desktop-smoke.mjs --restart"]
