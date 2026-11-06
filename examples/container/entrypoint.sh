#!/bin/sh
set -eu

# dori-superagent container entrypoint: start the herdr-core (hc) server, then run the
# container's command. Terminals are hosted by the core, so they are reachable from any
# `docker exec -it` session and outlive the shell that started them.

hc server start >/dev/null

exec "$@"
