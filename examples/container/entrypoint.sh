#!/bin/sh
set -eu

# dori-superagent container entrypoint: start the hc (herdr-core) server, then run the
# container's command. Sessions are hosted by the server, so they are reachable from
# any `docker exec -it` session.

hc server start >/dev/null

exec "$@"
