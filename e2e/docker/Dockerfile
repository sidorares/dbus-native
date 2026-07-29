# A Linux box with real desktop D-Bus services, for exercising dbus-native
# against something other than a bus we started ourselves.
#
# Node is the base image so the library under test runs natively; everything
# else is the desktop stack. See E2E_DOCKER_TESTING.md.
FROM node:24-bookworm

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
      dbus dbus-x11 \
      systemd \
      libglib2.0-bin \
      python3-dbus python3-gi gir1.2-glib-2.0 \
      xvfb \
      upower \
      accountsservice \
      policykit-1 \
      avahi-daemon avahi-utils \
      network-manager \
      udisks2 \
      dunst \
      xdg-desktop-portal \
      procps iproute2 \
    && rm -rf /var/lib/apt/lists/*

# The services below are system-bus services and expect to be root; the point
# here is protocol surface, not privilege separation.
COPY start-services.sh /usr/local/bin/start-services.sh
RUN chmod +x /usr/local/bin/start-services.sh

WORKDIR /work
ENTRYPOINT ["/usr/local/bin/start-services.sh"]
CMD ["node", "/work/e2e/tests/run.js"]
