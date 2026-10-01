FROM kong:3.9
USER root
COPY kong.yml /tmp/kong.yml
# ECS places an ADOT sidecar in the same task/network namespace, and Cloud Map registers
# each service as `<name>.horizon.local` where Compose names it `<name>`.
RUN mkdir -p /kong \
    && sed -E \
        -e 's#http://otel-collector:4318#http://127.0.0.1:4318#g' \
        -e 's#(url: http://)([a-z]+):([0-9]+)#\1\2.horizon.local:\3#' \
        /tmp/kong.yml > /kong/kong.yml \
    && chown kong:kong /kong/kong.yml
ENV KONG_DATABASE=off \
    KONG_DECLARATIVE_CONFIG=/kong/kong.yml \
    KONG_PROXY_LISTEN=0.0.0.0:8000 \
    KONG_ADMIN_LISTEN=off \
    KONG_PLUGINS=bundled
USER kong
