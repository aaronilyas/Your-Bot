FROM ubuntu:26.04 AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates xvfb xauth x11-utils libgtk-3-0 libnss3 libatk-bridge2.0-0 \
    libdrm2 libxkbcommon0 libgbm1 libasound2t64 libxshmfence1 libx11-xcb1 \
    libxss1 python3 python3-venv bubblewrap gcc libc6-dev \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 1001 desktop-test
FROM runtime
COPY apps/desktop/release/linux-unpacked/ /opt/your-bot/
COPY tests/desktop-smoke.mjs /validation/desktop-smoke.mjs
COPY tests/packaged-startup.sh /validation/packaged-startup.sh
COPY .validation/default_app.asar /opt/your-bot/resources/default_app.asar
RUN chown root:root /opt/your-bot/chrome-sandbox && chmod 4755 /opt/your-bot/chrome-sandbox \
    && cp -al /opt/your-bot /validation/driver \
    && mv /validation/driver/resources/app.asar /validation/application.asar
USER desktop-test
ENV HOME=/home/desktop-test
CMD ["sh", "-c", "xvfb-run -a sh /validation/packaged-startup.sh && xvfb-run -a /validation/driver/your-bot /validation/desktop-smoke.mjs && xvfb-run -a /validation/driver/your-bot /validation/desktop-smoke.mjs --restart"]
